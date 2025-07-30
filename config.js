export const CONFIG = {
  // Network limits
  MAX_MESSAGE_SIZE: 4 * 1024 * 1024, // 4MB
  RATE_LIMIT_MESSAGES: 250,
  RATE_LIMIT_WINDOW: 60_000,
  
  // libp2p settings
  P2P: {
    TCP_PORT: 26658,
    WS_PORT: 26659,
    MAX_CONNECTIONS: 50,
    MIN_CONNECTIONS: 10,
  }
};
