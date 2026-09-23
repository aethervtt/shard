import type { JsonRpcRequest, ProtocolServer } from './server'

export const DEFAULT_HUB_PORT = 7811

export interface HubConnectionOptions {
  /** Shown to the hub (and MCP clients) to identify this app, e.g. "playground" or "studio". */
  name: string
  /** Keep retrying with backoff when the hub isn't there. Default true. */
  reconnect?: boolean
  /** Called on connect/disconnect, for UI. */
  onStatus?: (connected: boolean) => void
}

/**
 * Connects an app to a protocol hub (the CLI or MCP server) over WebSocket. The app dials out, so a
 * browser tab can be driven as easily as a headless run. Returns a function that disconnects.
 */
export function connectToHub(
  url: string,
  server: ProtocolServer,
  options: HubConnectionOptions,
): () => void {
  let socket: WebSocket | undefined
  let closed = false
  let delay = 500
  let timer: ReturnType<typeof setTimeout> | undefined
  const offNotify = server.onNotification((n) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(n))
  })

  const open = () => {
    socket = new WebSocket(url)
    socket.onopen = () => {
      delay = 500
      socket!.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'hello',
          params: { name: options.name, protocol: 1 },
        }),
      )
      options.onStatus?.(true)
    }
    socket.onmessage = async (event) => {
      let request: JsonRpcRequest
      try {
        request = JSON.parse(String(event.data))
      } catch {
        return
      }
      const response = await server.handle(request)
      if (response && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response))
    }
    socket.onclose = () => {
      options.onStatus?.(false)
      if (closed || options.reconnect === false) return
      timer = setTimeout(open, delay)
      delay = Math.min(delay * 2, 10_000)
    }
    socket.onerror = () => {} // onclose follows; quiet when no hub is running
  }
  open()

  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    offNotify()
    socket?.close()
  }
}
