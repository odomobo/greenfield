import { ProxyFD } from './types.js'
import { createMemoryMappedFile, makePipe } from '../wayland-server.js'

export function createProxyInputOutput(): ProxyInputOutput {
  return new ProxyInputOutput()
}

/**
 * File descriptors handed to the (in-process) compositor. Everything is local now, so a ProxyFD is just a native fd
 * plus its type.
 */
export class ProxyInputOutput {
  proxyFDtoNativeFD(proxyFD: ProxyFD): number {
    return proxyFD.handle
  }

  mkpipe(): [ProxyFD, ProxyFD] {
    const pipeFds = new Uint32Array(2)
    makePipe(pipeFds)

    return [
      { handle: pipeFds[0], type: 'pipe-read' },
      { handle: pipeFds[1], type: 'pipe-write' },
    ]
  }

  mkstempMmap(buffer: Buffer): ProxyFD {
    return { handle: createMemoryMappedFile(buffer), type: 'shm' }
  }
}
