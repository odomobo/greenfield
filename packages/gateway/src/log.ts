/** Plain line logging. Never log passwords, cookies, tickets or launch environments. */
function line(level: string, message: string) {
  const stream = level === 'info' ? process.stdout : process.stderr
  stream.write(
    `${new Date().toISOString()} [${process.title === 'node' ? 'gateway' : process.title}] ${level}: ${message}\n`,
  )
}

export const log = {
  info: (message: string) => line('info', message),
  warn: (message: string) => line('warn', message),
  error: (message: string) => line('error', message),
}
