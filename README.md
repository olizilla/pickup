![](https://ipfs.io/ipfs/bafybeig5uisjbc25pkjwtyq5goocmwr7lz5ln63llrtw4d5s2y7m7nhyeu/ep-logo.svg)

# Pickup 🛻

**WIP - README DRIVEN DEV - NOT A THING YET**

Fetch content from IPFS as a CAR and push it to S3. AKA an elastic [pinning service api]. 🌐📌 

## Getting started

Requires **node.js v16** or higher. Install the dependencies with `npm i`.

Start the api in dev mode:

```console
$ npm start
16:33:45 ✨ Server listening at http://127.0.0.1:3000
```

## The plan

Lambda + Dynamo + SQS + ECS impl of the pinning service api

The pinning service frontend is a lambda:

`POST /pins {cid, name, origins, meta}` route creates:
- A pinning service record in a dynamo db table. Needed to fulfil the pinning service api. 
`(requestId, status, created, userid, appName, cid, name, origins[], meta{})`
- A message to sqs queue with details needed to fetch a cid and write CAR to S3. 
`(requestId, cid, origins[], awsRegion, s3Bucket, s3Path)`

The queue consumer is an autoscaling set of go-ipfs nodes (thanks @thattommyhall ✨), with a pickup sidecar, in ECS. The sidecar long-polls the sqs queue, gets next message, connects to `origins[]`, fetches `cid` as a CAR, and writes it to S3 at `(awsRegion, s3Bucket, s3Path)`.

While we wait for fetching the CAR to complete, we bump up the "visibility timeout" on the message, so that message remains hidden from other workers, up to a configured `ipfsTimeout`.

On failure, where processing hits an error or a timeout, pickup will stop incrementing the visibility timeout on the message and it becomes visible in the queue again to be retried.

After `maxRetries` we send the message to the Dead Letter Queue to take it out of circulation, and track metrics on failures.

Success means the complete CAR has been saved on s3, for indexing by Elastic provider 🌐✨. Pickup deletes the message from the queue. The CAR has the `psaRequestId` in it's metadata.

On succesful write to s3, a lambda is triggered to update status of DynamoDB record for that `psaRequestId`.

## Diagram

<pre>

                    ┌─────────────┐
                    │   lambda    │
    ●──────1.──────▶│ POST /pins  │────────2. insert──────────┐
                    └─────────────┘                           │
                           │                                  ▼
                           │                        /───────────────────\
                           │                        │                   │
                           │                        │     DynamoDB      │
                      3. send msg                   │    PinRequests    │
                           │                        │                   │
                           │                        \───────────────────/
                           │                                  ▲
                           ▼                                  │
                      ┌─────────┐                        8. update
                      │         │                             │
                      │         │                      ┌─────────────┐
                      │         │                      │   lambda    │
                      │   SQS   │                      │   S3 PUT    │
                      │  queue  │                      └─────────────┘
                      │         │                             ▲
                      │         │                             │
                      │         │                        7. S3 Event
                      └─────────┘                             │
                           │                        ┌───────────────────┐
                           │                        │                   │
                           │                        │        S3         │
                           │                        │                   │
           ─ ─ ─ ─ ─ ─ ─ ─ ┼─ 4. process msg─┐      └───────────────────┘
          │                                  │                ▲
                           │                 │                │
          │                                  │            6. S3 PUT
          ▼                ▼                 ▼                │
   ┌─────────────┐  ┌─────────────┐   ┌─────────────┐         │
┌ ─│             │─ ┤             ├ ─ ┤             ├ ┐       │
   │   pickup    │  │   pickup    │   │   pickup    │─────────┘
│  │             │  │             │   │             │ │
   └─────────────┘  └─────────────┘   └─────────────┘
│         │                │                 ▲        │
                                             │
│         │                │            5. ipfs get   │
                                             │
│         ▼                ▼                 ▼        │
   ┌─────────────┐  ┌─────────────┐   ┌─────────────┐
│  │             │  │             │   │             │ │
   │   go-ipfs   │  │   go-ipfs   │   │   go-ipfs   │
│  │             │  │             │   │             │ │
   └─────────────┘  └─────────────┘   └─────────────┘
ECS ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘

</pre>

## Integration with Elastic Provider

see: https://github.com/ipfs-elastic-provider/ipfs-elastic-provider

### Option 1 - use uploads v2

The initial /pins lambda asks web3.storage for a signed s3 upload url instead of picking the bucket to write to itself.
- Means we write the CAR directly into Elastic Provider. But we need something to say "upload complete" so that we update the PinRequests DynamoDB table... This could be done by pickup once the upload is complete. We would at that point have the full CAR, so we could mark it as pinned at that point, but it won't be available until later, after the elastic provider has processed it.


### Option 2 - inform Elastic provider on upload complete

Send a message on the indexer SQS topic from our lambda when the CAR is written to our s3 bucket.

## Questions

Rate limiting per user!
Thing to check before adding to the SQS queue
- do we already have the thing? Check with elastic provider.
- does the user have too many pin requests pending already.
- is the queue long? drop reqs at some threshold.


## References

> When a consumer (component 2) is ready to process messages, it consumes messages from the queue, and message A is returned. While message A is being processed, it remains in the queue and isn't returned to subsequent receive requests for the duration of the visibility timeout.
>
> The consumer (component 2) deletes message A from the queue to prevent the message from being received and processed again when the visibility timeout expires. 
> 
>https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-basic-architecture.html

> If you don't know how long it takes to process a message, create a heartbeat for your consumer process: Specify the initial visibility timeout (for example, 2 minutes) and then—as long as your consumer still works on the message—keep extending the visibility timeout by 2 minutes every minute.
>
> https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/working-with-messages.html

> Worker Services allow you to implement asynchronous service-to-service communication with pub/sub architectures. Your microservices in your application can publish events to Amazon SNS topics that can then be consumed by a "Worker Service".
>
> https://aws.github.io/copilot-cli/docs/concepts/services/#request-driven-web-service

> A Backend Service on AWS Copilot a one-click deployment of a gateway as a "backend service" (autoscaling at Fargate Spot pricing, each node has a port open so is a full participant in libp2p, 200G ssd for the datastore, 4cores and up to 30G RAM, no LB though - dns based discovery for client-side load balancing).
>
> https://github.com/ipfs-shipyard/go-ipfs-docker-examples/tree/main/gateway-copilot-backend-service


[pinning service api]: https://ipfs.github.io/pinning-services-api-spec/

## Notes

**what copilot did** - for a worker service it sets up

```console
✔ Proposing infrastructure changes for the pickup-test environment.
- Creating the infrastructure for the pickup-test environment.                [create complete]  [71.4s]
  - An IAM Role for AWS CloudFormation to manage resources                    [create complete]  [15.6s]
  - An ECS cluster to group your services                                     [create complete]  [10.5s]
  - An IAM Role to describe resources in your environment                     [create complete]  [14.0s]
  - A security group to allow your containers to talk to each other           [create complete]  [5.7s]
  - An Internet Gateway to connect to the public internet                     [create complete]  [20.3s]
  - Private subnet 1 for resources with no internet access                    [create complete]  [5.7s]
  - Private subnet 2 for resources with no internet access                    [create complete]  [5.7s]
  - A custom route table that directs network traffic for the public subnets  [create complete]  [12.0s]
  - Public subnet 1 for resources that can access the internet                [create complete]  [5.7s]
  - Public subnet 2 for resources that can access the internet                [create complete]  [9.5s]
  - A private DNS namespace for discovering services within the environment   [create complete]  [45.4s]
  - A Virtual Private Cloud to control networking of your AWS resources       [create complete]  [17.3s]
✔ Created environment test in region us-east-2 under application pickup.

...

✔ Proposing infrastructure changes for stack pickup-test-ipfs
- Creating the infrastructure for stack pickup-test-ipfs                      [create complete]  [271.1s]
  - Update your environment's shared resources                                [create complete]  [3.2s]
  - An IAM role to update your environment stack                              [create complete]  [16.6s]
  - A KMS key to encrypt messages in your queues                              [create complete]  [123.5s]
  - An events SQS queue to buffer messages                                    [create complete]  [75.1s]
  - An IAM Role for the Fargate agent to make AWS API calls on your behalf    [create complete]  [13.7s]
  - A CloudWatch log group to hold your service logs                          [create complete]  [3.1s]
  - An ECS service to run and maintain your tasks in the environment cluster  [create complete]  [41.5s]
    Deployments                                                                                   
               Revision  Rollout      Desired  Running  Failed  Pending                                   
      PRIMARY  1         [completed]  1        1        0       0                                         
  - An ECS task definition to group your containers and run them on ECS       [create complete]  [4.7s]
  - An IAM role to control permissions for the containers in your tasks       [create complete]  [16.6s]
✔ Deployed service ipfs.

```