import { GetObjectCommand } from '@aws-sdk/client-s3'
import { unpackStream } from 'ipfs-car/unpack'
import { createS3Uploader } from '../lib/s3.js'
import { pickup, pickupBatch } from '../lib/pickup.js'
import { Buffer } from 'buffer'
import test from 'ava'
import { compose } from './_compose.js'

test.before(async t => {
  t.timeout(1000 * 60)
  // Start local ipfs and minio daemons for testing against.
  t.context = await compose()
})

test('happy path', async t => {
  const { s3, createBucket, ipfsApiUrl } = t.context
  const cid = 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e' // hello world
  const key = `psa/${cid}.car`
  const bucket = await createBucket()
  await t.throwsAsync(s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })))

  await pickup({
    upload: createS3Uploader({ client: s3, key, bucket }),
    ipfsApiUrl,
    origins: [],
    cid
  })

  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const files = await resToFiles(res)
  t.is(files.length, 1, '1 file in the test CAR')

  const content = await fileToString(files[0])
  t.is(content, 'hello world', 'expected file content')
  t.pass()
})

test('with origins', async t => {
  const { s3, createBucket, ipfsApiUrl } = t.context
  const cid = 'bafkreig6ylslysmsgffjzgsrxpmftynqqg3uc6ebrrj4dhiy233wd5oyaq' // "test 2"
  const key = `psa/${cid}.car`
  const bucket = await createBucket()
  await t.throwsAsync(s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })))

  await pickup({
    upload: createS3Uploader({ client: s3, key, bucket }),
    ipfsApiUrl,
    origins: ['/dns4/peer.ipfs-elastic-provider-aws.com/tcp/3000/ws/p2p/bafzbeibhqavlasjc7dvbiopygwncnrtvjd2xmryk5laib7zyjor6kf3avm'],
    cid
  })

  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const files = await resToFiles(res)
  t.is(files.length, 1, '1 file in the test CAR')

  const content = await fileToString(files[0])
  t.is(content, 'test 2', 'expected file content')
  t.pass()
})

test('with bad origins', async t => {
  const { s3, createBucket, ipfsApiUrl } = t.context
  const cid = 'bafkreihyyavekzt6coios4bio3ou3rwaazxetnonvjxmdsb6pwel5exc4i' // "test 3"
  const key = `psa/${cid}.car`
  const bucket = await createBucket()
  await t.throwsAsync(s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })))

  await pickup({
    upload: createS3Uploader({ client: s3, key, bucket }),
    ipfsApiUrl,
    origins: ['derp'],
    cid
  })

  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const files = await resToFiles(res)
  t.is(files.length, 1, '1 file in the test CAR')

  const content = await fileToString(files[0])
  t.is(content, 'test 3', 'expected file content')
  t.pass()
})

test.only('pickupBatch', async t => {
  const { s3, createBucket, ipfsApiUrl } = t.context
  const bucket = await createBucket()
  const cids = [
    'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
    'bafkreig6ylslysmsgffjzgsrxpmftynqqg3uc6ebrrj4dhiy233wd5oyaq',
    'bad'
  ]
  const msgs = cids.map((cid, i) => ({
    Body: JSON.stringify({
      cid,
      bucket,
      key: `batch/${cid}.car`,
      requestid: `#${i}`
    })
  }))

  const res = await pickupBatch(msgs, { createS3Uploader, s3, ipfsApiUrl })

  t.is(res.length, 2)
  const sorted = res.map(msg => JSON.parse(msg.Body)).sort()
  for (let i = 0; i < sorted.length; i++) {
    t.is(sorted[i].cid, cids[i])
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `batch/${cids[i]}.car` }))
    t.is(res.$metadata.httpStatusCode, 200)
  }
})

async function resToFiles (res) {
  const files = []
  for await (const file of unpackStream(res.Body)) {
    files.push(file)
  }
  return files
}

async function fileToString (file) {
  const chunks = []
  for await (const chunk of file.content()) {
    chunks.push(chunk)
  }
  const buf = Buffer.concat(chunks)
  return buf.toString()
}
