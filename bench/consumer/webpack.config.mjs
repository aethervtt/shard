import { resolve } from 'node:path'

export default {
  mode: 'production',
  entry: './compat.ts',
  // Exercise OpenType's ESM build, as Next's webpack client resolver does.
  resolve: { mainFields: ['module', 'browser', 'main'] },
  output: { path: resolve('dist-webpack'), filename: 'main.js', clean: true },
  module: { rules: [{ test: /\.ts$/, type: 'javascript/auto', loader: './strip-types.cjs' }] },
  performance: { hints: false },
}
