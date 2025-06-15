// webpack.config.cjs - Fixed for worker context
const path = require('path');
const webpack = require('webpack');

module.exports = {
  entry: './wt-p2p-bundle.js',
  output: {
    filename: 'wt-p2p.dist.js',
    path: path.resolve(__dirname, 'dist'),
    module: true,
    library: {
      type: 'module'
    }
  },
  experiments: {
    outputModule: true
  },
  mode: 'development',
  devtool: 'source-map',
  target: 'webworker', // Change from 'web' to 'webworker'
  resolve: {
    fallback: {
      "buffer": require.resolve("buffer/"),
      "stream": require.resolve("stream-browserify"),
      "crypto": require.resolve("crypto-browserify"),
      "path": require.resolve("path-browserify"),
      "process": require.resolve("process/browser.js"),
      "vm": require.resolve("vm-browserify"),
      "fs": false,
      "net": false,
      "tls": false,
      "dgram": false,
      "dns": false,
      "http": false,
      "https": false,
      "os": false,
      "url": require.resolve("url/"),
      "util": require.resolve("util/"),
      "assert": require.resolve("assert/")
    },
    alias: {
      'process': 'process/browser.js'
    }
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser.js'
    }),
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify('development'),
      'process.browser': true,
      'process.version': JSON.stringify('v16.0.0'),
      'global': 'self',  // Use self in worker context
      'globalThis': 'self',  // Use self in worker context
      'window': '(typeof self !== "undefined" ? self : {})'  // Fake window object
    })
  ],
  module: {
    rules: [
      {
        test: /\.m?js$/,
        resolve: {
          fullySpecified: false
        }
      }
    ]
  }
};
