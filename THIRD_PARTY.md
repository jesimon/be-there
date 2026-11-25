# Other people's work in Be There

Be There's own code is in this repository. Live captions also use the software, models and recording listed here. None of these files are in the repository: the server fetches each from the address below, checks it against the size and SHA-256 in `lib/captions-files.js`, and serves it to home screens itself (at `/captions-files/v1/…`). This page is also served at `/third-party`.

| What | Version | Licence | Where it comes from |
| --- | --- | --- | --- |
| **Transformers.js**, the library that runs the models in the browser (`transformers.min.js`) | 4.3.2 | Apache-2.0 | npm `@huggingface/transformers@4.3.2`, file `dist/transformers.min.js`, by way of `cdn.jsdelivr.net`. Source: https://github.com/huggingface/transformers.js |
| **ONNX Runtime Web**, what the models run on (`ort-wasm-simd-threaded.mjs` and `.wasm`: the plain build, on one thread) | 1.31.0-dev.20260914-8d85527a0, the build Transformers.js 4.3.2 is made for | MIT | npm `onnxruntime-web@1.31.0-dev.20260914-8d85527a0`, folder `dist/`, by way of `cdn.jsdelivr.net`. Source: https://github.com/microsoft/onnxruntime |
| **Moonshine tiny**, the speech model (English), as exported for the web | `onnx-community/moonshine-tiny-ONNX` at revision `a6da1241cd305dcd64eab1edbd615f2bb9aabb95`: seven files, the two model files in their 8-bit ("quantized") form | MIT | https://huggingface.co/onnx-community/moonshine-tiny-ONNX. The model is by Useful Sensors (Moonshine AI): https://github.com/moonshine-ai/moonshine, paper https://arxiv.org/abs/2410.15608 |
| **Silero VAD**, which tells speech from quiet | `onnx-community/silero-vad` at revision `e71cae966052b992a7eca6b17738916ce0eca4ec`, file `onnx/model.onnx` | MIT | https://huggingface.co/onnx-community/silero-vad. The model is by the Silero Team: https://github.com/snakers4/silero-vad |
| **The sample of speech** for the check page and the tests (`jfk.wav`): eleven seconds of President Kennedy's inaugural address, 20 January 1961 | `Xenova/transformers.js-docs` (a dataset) at revision `542437c29cc5273cfd29e25c77696f2b349badd7` | Public domain (a work of the United States government) | https://huggingface.co/datasets/Xenova/transformers.js-docs |

`transformers.min.js` is a bundle: it carries the JavaScript parts of ONNX Runtime (MIT, Microsoft Corporation) and Hugging Face's own smaller libraries (Apache-2.0 and MIT) inside it.

Used only by the tests, and never loaded by the app or sent to anyone: `node-turn` 0.0.6 (MIT), a small relay server for `npm run e2e`.

## Their notices

**Transformers.js.** Copyright the Hugging Face team and contributors. Licensed under the Apache License, Version 2.0; you may not use it except in compliance with the License. A copy of the License is at https://www.apache.org/licenses/LICENSE-2.0. It is distributed on an "AS IS" basis, without warranties or conditions of any kind. Be There serves the file unchanged.

**ONNX Runtime.** Copyright (c) Microsoft Corporation.
**Moonshine.** Copyright (c) 2025 Useful Sensors, Inc. (dba Moonshine AI).
**Silero VAD.** Copyright (c) 2020-present Silero Team.

These three are under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Changing any of these

A new version of any file means a new entry in `lib/captions-files.js` (address, size, SHA-256) and a new `CAPTIONS_VERSION`, because browsers are told to keep each version's files for good. Transformers.js and the ONNX Runtime files must be changed together: the library is made for one exact build of the runtime. Update this page in the same change.
