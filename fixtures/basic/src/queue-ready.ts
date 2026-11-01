export let ready = false

let chain = Promise.resolve()
for (let i = 0; i < 1000; i++) chain = chain.then(() => {})
void chain.then(() => {
  ready = true
})
