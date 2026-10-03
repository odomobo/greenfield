import { Configschema, createLogger } from '@gfld/compositor-proxy'
import { createServer, IncomingMessage } from 'node:http'
import { ChildProcess, fork } from 'node:child_process'
import { ToSessionProcessMessage } from './SessionProcess.js'
import { Socket } from 'node:net'
import { authRequest, handleLaunch, handleListApps, handleOptions, sessionIdFromURL } from './main-controller.js'
import { args } from './main-args.js'
import { inspect } from 'node:util'
import path from 'node:path'
import { WebSocketServer } from 'ws'

process.on('uncaughtException', (e) => {
  logger.error('\tname: ' + e.name + ' message: ' + e.message)
  logger.error('error object stack: ')
  logger.error(e.stack ?? '')
})

const logger = createLogger('main')

const sessionProcesses: Record<string, ChildProcess> = {}

function main() {
  logger.info(`Starting compositor proxy with args: ${inspect(args)}`)

  const config: Configschema = {
    server: {
      http: {
        allowOrigin: args['allow-origin'],
        bindIP: args['bind-ip'],
        bindPort: +args['bind-port'],
      },
    },
    public: {
      baseURL: args['base-url'],
    },
    encoder: {
      h264Encoder: args['encoder'],
      renderDevice: args['render-device'],
    },
  }

  const server = createServer({ noDelay: true })

  const ensureSessionProcess = (compositorSessionId: string): ChildProcess => {
    let childProcess = sessionProcesses[compositorSessionId]
    if (childProcess !== undefined) {
      return childProcess
    }
    logger.info(`Starting session "${compositorSessionId}".`)
    childProcess = fork(path.join(__dirname, './SessionProcess'))
    childProcess.once('exit', (code, signal) => {
      logger.info(`Session "${compositorSessionId}" exited: ${signal || code}`)
      delete sessionProcesses[compositorSessionId]
    })
    childProcess.once('error', (err) => {
      logger.error(`Session "${compositorSessionId}" error: ${err.message}`)
      delete sessionProcesses[compositorSessionId]
    })
    sessionProcesses[compositorSessionId] = childProcess
    const start: ToSessionProcessMessage = {
      type: 'start',
      payload: { compositorSessionId, config },
    }
    // queued by node until the child is up
    childProcess.send(start)
    return childProcess
  }

  const rejectUpgrade = (request: IncomingMessage, socket: Socket, code: number) => {
    new WebSocketServer({ perMessageDeflate: false, noServer: true }).handleUpgrade(
      request,
      socket,
      Buffer.from([]),
      (ws) => ws.close(code),
    )
  }

  server.on('upgrade', (request, socket: Socket) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`)
    const compositorSessionId = sessionIdFromURL(url)
    if (compositorSessionId === undefined || url.pathname !== '/viewer') {
      rejectUpgrade(request, socket, 4403)
      return
    }
    // TODO authenticate viewers (login/gateway)

    // attaching a viewer starts the session if it doesn't exist yet
    const childProcess = ensureSessionProcess(compositorSessionId)
    socket.pause()
    const wsUpgrade: ToSessionProcessMessage = {
      type: 'wsUpgrade',
      payload: {
        request: {
          headers: request.headers,
          url: request.url,
          method: request.method,
        },
      },
    }
    childProcess.send(wsUpgrade, socket as Socket)
  })

  server.on('request', (request, response) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`)
    if (request.method === 'OPTIONS') {
      handleOptions(config, request, response)
      return
    }

    if (request.method === 'GET') {
      if (!authRequest(request, response)) {
        return
      }

      if (url.pathname === '/apps') {
        handleListApps(config, response, args['applications'])
        return
      }

      if (url.pathname === '/launch') {
        const compositorSessionId = sessionIdFromURL(url)
        if (compositorSessionId === undefined) {
          response.writeHead(400, 'Bad Request').end()
          return
        }
        handleLaunch(ensureSessionProcess(compositorSessionId), config, response, url, args['applications'])
        return
      }

      response.writeHead(404, 'Not Found').end()
      return
    }

    response
      .writeHead(405, 'Method Not Allowed', {
        Allow: 'GET,OPTIONS',
      })
      .end()
  })

  const port = config.server.http.bindPort
  const host = config.server.http.bindIP

  server.on('listening', () => {
    const shutdown = (signal: string) => {
      logger.info(`Received ${signal}. Stopping sessions.`)
      server.closeAllConnections()
      for (const childProcess of Object.values(sessionProcesses)) {
        childProcess.kill('SIGTERM')
      }
      setTimeout(() => process.exit(), 1000)
    }
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    process.once('SIGINT', () => shutdown('SIGINT'))

    logger.info(`Compositor proxy started. Listening on ${host}:${port}`)
  })
  server.on('error', (err) => {
    logger.error(err.message)
  })
  server.listen(port, host)
}

main()
