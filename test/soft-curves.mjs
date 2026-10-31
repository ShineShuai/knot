// LEGACY-CURVES. Preload for `npm run test:soft`: run the unit tests as on a browser without WebCrypto curves.
import { forceSoftCurves } from '../src/crypto/curves.js';

forceSoftCurves();
