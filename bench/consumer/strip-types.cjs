// Node's erasure is enough for this fixture; the packages already contain plain JS.
module.exports = (source) => require('node:module').stripTypeScriptTypes(source)
