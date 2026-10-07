import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { GatewayConfig } from './config'
import { log } from './log'

/**
 * Reads the configured certificate and key, or generates a self-signed pair in the state dir on first run. Started by
 * the monitor, the key stays readable by the monitor only and its contents are handed to the web process over IPC;
 * started by a login helper, the web process reads it itself.
 */
export async function loadTLS(
  config: Pick<GatewayConfig, 'certFile' | 'keyFile' | 'stateDir'>,
): Promise<{ cert: string; key: string }> {
  let certFile = config.certFile
  let keyFile = config.keyFile
  if (certFile === undefined || keyFile === undefined) {
    certFile = path.join(config.stateDir, 'tls', 'cert.pem')
    keyFile = path.join(config.stateDir, 'tls', 'key.pem')
    if (!existsSync(certFile) || !existsSync(keyFile)) {
      await generateSelfSigned(certFile, keyFile)
    }
  }
  const cert = readFileSync(certFile, 'utf8')
  const key = readFileSync(keyFile, 'utf8')
  const x509 = new X509Certificate(cert)
  log.info(`TLS certificate ${certFile}`)
  log.info(`  subject: ${x509.subject.replace(/\n/g, ', ')}  valid until: ${x509.validTo}`)
  log.info(`  SHA-256 fingerprint: ${x509.fingerprint256}`)
  return { cert, key }
}

function generateSelfSigned(certFile: string, keyFile: string): Promise<void> {
  const dir = path.dirname(certFile)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const host = hostname()
  log.info(`Generating a self-signed TLS certificate for "${host}" in ${dir}`)
  return new Promise((resolve, reject) => {
    execFile(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-days',
        '825',
        '-subj',
        `/CN=${host}`,
        '-addext',
        `subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1,IP:::1`,
        '-keyout',
        keyFile,
        '-out',
        certFile,
      ],
      (error) => {
        if (error) {
          reject(new Error(`Could not generate a TLS certificate with openssl: ${error.message}`))
          return
        }
        chmodSync(keyFile, 0o600)
        resolve()
      },
    )
  })
}
