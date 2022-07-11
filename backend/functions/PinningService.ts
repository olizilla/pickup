import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { OpenAPIBackend } from 'openapi-backend'
import { Context as OAContext } from 'openapi-backend/backend'
import { APIGatewayProxyStructuredResultV2, APIGatewayProxyHandlerV2 } from 'aws-lambda'
import { Pin, PinQuery, PinStatus } from '../schema'
import DynamoDBPinningService from '../db'

interface Response extends APIGatewayProxyStructuredResultV2 {
  body: any
}

const { TABLE_NAME: table, BUCKET_NAME: bucket, QUEUE_URL: QueueUrl } = process.env

const db = new DynamoDBPinningService({ table })
const sqs = new SQSClient({})

async function sendMessage (status: PinStatus): Promise<void> {
  const { requestid, pin } = status
  const { cid, origins } = pin
  const message = {
    requestid,
    cid,
    origins,
    bucket,
    key: `pickup/${cid}/${cid}.root.car`
  }
  await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify(message) }))
}

function getUserId (accessToken: string): string {
  // TODO: map access token to user id
  return accessToken
}

// GET /pins
export async function getPins (c: OAContext): Promise<Response> {
  const query = c.request.query as PinQuery
  const userid = getUserId(c.security.accessToken)
  try {
    const body = await db.getPins(userid, query)
    return { statusCode: 200, body }
  } catch (error) {
    console.log(error)
    return { statusCode: 500, body: { error: { reason: 'INTERNAL_SERVER_ERROR' } } }
  }
}

// POST /pins
export async function addPin (c: OAContext): Promise<Response> {
  const pin = c.request.requestBody as Pin
  const userid = getUserId(c.security.accessToken)
  try {
    const body = await db.addPin(userid, pin)
    // todo: retry if error sending message
    await sendMessage(body)
    return { statusCode: 200, body }
  } catch (error) {
    console.log(error)
    return { statusCode: 500, body: { error: { reason: 'INTERNAL_SERVER_ERROR' } } }
  }
}

// GET /pins/{requestid}
export async function getPinByRequestId (c: OAContext): Promise<Response> {
  const requestid = first(c.request.params.requestid)
  const userid = getUserId(c.security.accessToken)
  try {
    const status = await db.getPinByRequestId(userid, requestid)
    if (status != null) {
      return { statusCode: 200, body: status }
    }
    return { statusCode: 404, body: { error: { reason: 'NOT_FOUND' } } }
  } catch (error) {
    console.log(error)
    return { statusCode: 500, body: { error: { reason: 'INTERNAL_SERVER_ERROR' } } }
  }
}

// POST /pins/{requestid}
export async function replacePinByRequestId (c: OAContext): Promise<Response> {
  const requestid = first(c.request.params.requestid)
  const pin = c.request.requestBody as Pin
  const userid = getUserId(c.security.accessToken)
  try {
    const status = await db.replacePinByRequestId(userid, requestid, pin)
    if (status !== undefined) {
      return { statusCode: 200, body: status }
    }
    return { statusCode: 404, body: { error: { reason: 'NOT_FOUND' } } }
  } catch (error) {
    console.log(error)
    return { statusCode: 500, body: { error: { reason: 'INTERNAL_SERVER_ERROR' } } }
  }
}

// DELETE /pins/{requestid}
export async function deletePinByRequestId (c: OAContext): Promise<Response> {
  const body = { operationId: c.operation.operationId }
  return { statusCode: 501, body }
}

export async function unauthorizedHandler (c: OAContext): Promise<Response> {
  // @ts-expect-error
  const body = c.api.document.components?.examples?.UnauthorizedExample?.value
  return { statusCode: 401, body }
}

export async function validationFail (c: OAContext): Promise<Response> {
  const details = c.validation.errors?.map(err => [err.instancePath, err.message].filter(Boolean).join(' ')).join(', ')
  const body = { error: { reason: 'BAD_REQUEST', details } }
  return { statusCode: 400, body }
}

export async function notFound (c: OAContext): Promise<Response> {
  // @ts-expect-error
  const body = c.api.document.components?.examples?.NotFoundExample?.value
  return { statusCode: 404, body }
}

function first (a: string | string[]): string {
  return Array.isArray(a) ? a[0] : a
}

const api = new OpenAPIBackend({
  definition: './ipfs-pinning-service.yaml',
  // quick means lazily compile ajv validators as needed.
  quick: true,
  // have to add date-time validator, taken from https://github.com/anttiviljami/openapi-backend/issues/280#issuecomment-1017481557
  customizeAjv: (ajv, ajvOpts, validationContext) => {
    const dtFormat = {
      type: 'string',
      validate: /^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i
    }
    ajv.addFormat('date-time', dtFormat as any)
    return ajv
  }
})

api.register({
  addPin,
  getPins,
  getPinByRequestId,
  replacePinByRequestId,
  deletePinByRequestId,
  unauthorizedHandler,
  validationFail,
  notFound
})

api.registerSecurityHandler('accessToken', function (c) {
  const authHeader = c.request.headers.authorization
  if (Array.isArray(authHeader)) {
    throw new Error('Too many authorization headers')
  }
  const token = authHeader.replace('Bearer ', '')
  // TODO: verify tokens!
  return token === 'super-duper-admin' ? token : false
})

// the main export called by lambda, maps lamda things to openapi-backend things
export const handler: APIGatewayProxyHandlerV2 = async (event, awsContext) => {
  const openApiContext = {
    method: event.requestContext.http.method,
    path: event.rawPath,
    query: event.rawQueryString,
    body: event.body,
    headers: event.headers
  }
  // @ts-expect-error the openapi-backend types need updating to deal with v2 where value could be undefined.
  return await api.handleRequest(openApiContext, event, awsContext)
}
