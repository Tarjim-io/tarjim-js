import { SDK_VERSION } from '@tarjim/core';
import { Tarjim } from './tarjim.js';

// The whole script-tag surface: window.Tarjim is this namespace, never an instance.
export const start = Tarjim.start;
export const version = SDK_VERSION;
