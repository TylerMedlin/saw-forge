// App windows run sandboxed with no system access; they only learn that they
// are running on the desktop (and which platform), e.g. to adjust wording.
'use strict';
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('sawforgeDesktop', Object.freeze({ platform: process.platform, desktop: true }));
