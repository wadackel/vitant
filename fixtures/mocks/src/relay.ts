export function ping(send: (message: string) => void): void {
  send('ping')
}

export function burst(send: (message: string) => void, times: number): void {
  for (let i = 0; i < times; i++) send('burst')
}
