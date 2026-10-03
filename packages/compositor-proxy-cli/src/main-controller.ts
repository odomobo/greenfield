import { ToMainProcessMessage, ToSessionProcessMessage } from './SessionProcess.js'
import { ChildProcess } from 'node:child_process'
import { Configschema, createLogger } from '@gfld/compositor-proxy'
import { IncomingMessage, ServerResponse } from 'node:http'
import { args } from './main-args.js'
import { AppConfigSchema } from './app-config.js'

const allowHeaders = 'Content-Type, Authorization, WWW-Authenticate'
const maxAge = '36000'
let messageSerial = 0

const logger = createLogger('main')
const basicAuth = args['basic-auth']
let user: string | undefined
let password: string | undefined
if (basicAuth) {
  ;[user, password] = basicAuth.split(':')
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const DEFAULT_SESSION_ID = 'default'

/**
 * The session a request is for. Until there is a login, sessions are simply named by the `session` query parameter.
 * TODO replace with authenticated, per-user sessions.
 */
export function sessionIdFromURL(url: URL): string | undefined {
  const sessionId = url.searchParams.get('session') ?? DEFAULT_SESSION_ID
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId : undefined
}

/**
 * Returns false (and answers the request) if basic auth is configured and the request doesn't match it.
 */
export function authRequest(request: IncomingMessage, response: ServerResponse): boolean {
  if (user === undefined || password === undefined) {
    return true
  }
  const authHeader = request.headers['authorization']
  if (authHeader !== undefined) {
    const [givenUser, givenPassword] = Buffer.from(authHeader.split(' ')[1] ?? '', 'base64')
      .toString()
      .split(':')
    if (user === givenUser && givenPassword === password) {
      return true
    }
  }
  response
    .writeHead(401, 'Not authenticated', {
      'www-authenticate': 'Basic realm="Login",charset="UTF-8"',
    })
    .end()
  return false
}

function corsHeaders(config: Configschema): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': config.server.http.allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
  }
}

function isToMainProcessMessage(message: any): message is ToMainProcessMessage {
  return message.type === 'launchAppSuccess' || message.type === 'launchAppFailed'
}

function sendMessageWithReply<T extends Extract<ToSessionProcessMessage, { type: 'launchApp' }>>(
  childProcess: ChildProcess,
  message: T,
  timeout = 10000,
): Promise<NonNullable<T['reply']>> {
  return new Promise((resolve, reject) => {
    const sendSerial = message.payload.serial
    const timeoutHandle = setTimeout(() => {
      childProcess.removeListener('message', replyListener)
      reject(new Error(`Sending message: ${JSON.stringify(message)} timed out with no reply after ${timeout}ms.`))
    }, timeout)
    const replyListener = (message: any) => {
      if (isToMainProcessMessage(message)) {
        if (message.payload.replySerial === sendSerial) {
          clearTimeout(timeoutHandle)
          childProcess.removeListener('message', replyListener)
          resolve(message)
        }
      }
    }
    childProcess.on('message', replyListener)
    childProcess.send(message)
  })
}

export function handleOptions(config: Configschema, request: IncomingMessage, response: ServerResponse) {
  const origin = request.headers['origin']
  const accessControlRequestMethod = request.headers['access-control-request-method']
  if (origin === '' || accessControlRequestMethod === '') {
    // not a preflight check, abort
    response.writeHead(200, 'OK').end()
    return
  }

  response
    .writeHead(204, 'No Content', {
      ...corsHeaders(config),
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': allowHeaders,
      'Access-Control-Max-Age': maxAge,
    })
    .end()
}

function replyJSON(config: Configschema, response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { ...corsHeaders(config), 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

/**
 * GET /apps: the launchable applications.
 */
export function handleListApps(config: Configschema, response: ServerResponse, applications: AppConfigSchema) {
  replyJSON(
    config,
    response,
    200,
    Object.entries(applications).map(([path, { name }]) => ({ path, name })),
  )
}

/**
 * GET /launch?session=ID&app=PATH: launch an application in a session.
 */
export async function handleLaunch(
  childProcess: ChildProcess,
  config: Configschema,
  response: ServerResponse,
  url: URL,
  applications: AppConfigSchema,
) {
  const appPath = url.searchParams.get('app') ?? ''
  const app = applications[appPath]
  if (app === undefined) {
    replyJSON(config, response, 404, { error: 'Application not found.' })
    return
  }

  try {
    const launchApp: ToSessionProcessMessage = {
      type: 'launchApp',
      payload: { name: app.name, executable: app.executable, args: app.args, env: app.env, serial: messageSerial++ },
    }
    const messageReply = await sendMessageWithReply(childProcess, launchApp)
    if (messageReply.type === 'launchAppFailed') {
      replyJSON(config, response, 500, { error: 'Application could not be started.' })
      return
    }
    replyJSON(config, response, 201, { name: app.name, pid: messageReply.payload.pid })
  } catch (e: any) {
    logger.error(e)
    replyJSON(config, response, 500, { error: 'Application could not be started.' })
  }
}
