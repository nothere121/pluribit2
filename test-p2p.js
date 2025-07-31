if (typeof CustomEvent === 'undefined') {
  class CustomEvent extends Event {
    constructor(type, options) {
      super(type, options);
      this.detail = options?.detail || null;
    }
  }
  global.CustomEvent = CustomEvent;
}
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
import { PluribitP2P, TOPICS } from './libp2p-node.js';

async function test() {
  console.log('Testing P2P...');
  
  // Create two nodes
  const node1 = new PluribitP2P(console.log);
  const node2 = new PluribitP2P(console.log);
  
  // Override ports
  node1.config.listen.tcp = 30001;
  node1.config.listen.ws = 30002;
  node2.config.listen.tcp = 30003;
  node2.config.listen.ws = 30004;
  
  await node1.initialize();
  await node2.initialize();
  
  // Connect them
  const node1Addr = node1.node.getMultiaddrs()[0];
  await node2.node.dial(node1Addr);
  
  // Test pubsub
  await node1.subscribe(TOPICS.BLOCKS, (msg) => {
    console.log('Node 1 received:', msg);
  });
  
  await new Promise(r => setTimeout(r, 1000));
  
  await node2.publish(TOPICS.BLOCKS, {
    type: 'test',
    payload: { height: 100 }
  });
  
  // Test DHT
  await node1.store('test-key', { data: 'hello' });
  const result = await node2.get('test-key');
  console.log('DHT result:', result);
  
  // Cleanup
  setTimeout(async () => {
    await node1.stop();
    await node2.stop();
    process.exit(0);
  }, 2000);
}

test().catch(console.error);
