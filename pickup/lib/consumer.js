import retry from 'p-retry'
import { Consumer } from 'sqs-consumer'
import { createS3Uploader } from './s3.js'
import { testIpfsApi, waitForGC, repoStat, connectTo } from './ipfs.js'
import { pickup, pickupBatch } from './pickup.js'

export async function createConsumer ({ ipfsApiUrl, queueUrl, s3 }) {
  // throws if can't connect
  await retry(() => testIpfsApi(ipfsApiUrl), { maxRetryTime: 1000 * 5 })

  const app = Consumer.create({
    queueUrl,
    batchSize: 2, // 1 to 10
    visibilityTimeout: 20, // seconds, how long to hide message from queue after reading.
    heartbeatInterval: 10, // seconds, must be lower than `visibilityTimeout`. how long before increasing the `visibilityTimeout`
    // allow 4hrs before timeout. 2/3rs of the world can upload faster than
    // 20Mbit/s (fixed broadband), at which 32GiB would transfer in 3.5hrs.
    // we can make this more or less generous, but note it ties up a worker.
    // see: https://www.speedtest.net/global-index
    // see: https://www.omnicalculator.com/other/download-time?c=GBP&v=fileSize:32!gigabyte,downloadSpeed:5!megabit
    // TODO: enforce 32GiB limit
    // TODO: monitor throughput and bail early if stalled.
    handleMessageTimeout: 4 * 60 * 60 * 1000, // ms, error if processing takes longer than this.
    handleMessageBatch: async (messages) => {
      return pickupBatch(messages, { ipfsApiUrl, createS3Uploader, s3 })
    }
    // handleMessage: async (message) => {
    //   const { cid, origins, bucket, key, requestid } = JSON.parse(message.Body)
    //   await pickup({
    //     upload: createS3Uploader({ bucket, key, client: s3 }),
    //     ipfsApiUrl,
    //     origins,
    //     cid
    //   })
    //   console.log(await repoStat(ipfsApiUrl))
    // }
  })

  app.on('error', (err) => {
    console.error(err.message)
  })

  app.on('processing_error', (err) => {
    console.error(err.message)
  })

  return app
}
