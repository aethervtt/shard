// The default track worker entry (0053): `trackWorker()` starts it. It knows the built-in `sleep`
// settle rule; a package with its own rules ships its own entry that calls serveTracks.

import { serveTracks } from './serve'

serveTracks()
