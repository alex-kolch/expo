import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { createBundleUrlPath, ExpoMetroOptions } from './metroOptions';
import type { ServerRequest, ServerResponse } from './server.types';
import { Log } from '../../../log';
import { fileExistsAsync } from '../../../utils/dir';
import { memoize } from '../../../utils/fn';
import { fileURLToFilePath } from '../metro/createServerComponentsMiddleware';

export type PickPartial<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

const warnUnstable = memoize(() =>
  Log.warn('Using experimental DOM Components API. Production exports may not work as expected.')
);

export function createDomComponentsMiddleware(
  {
    projectRoot,
    metroRoot,
    getDevServerUrl,
  }: { projectRoot: string; metroRoot: string; getDevServerUrl: () => string },
  instanceMetroOptions: PickPartial<ExpoMetroOptions, 'mainModuleName' | 'platform' | 'bytecode'>
) {
  async function getDomComponentVirtualEntryModuleAsync(file: string) {
    const filePath = file.startsWith('file://') ? fileURLToFilePath(file) : file;

    const hash = crypto.createHash('sha1').update(filePath).digest('hex');

    const generatedEntry = path.join(projectRoot, '.expo/@dom', hash + '.js');

    const entryFile = getDomComponentVirtualProxy(generatedEntry, filePath);

    fs.mkdirSync(path.dirname(entryFile.filePath), { recursive: true });

    const exists = await fileExistsAsync(entryFile.filePath);
    // TODO: Assert no default export at runtime.
    await fs.promises.writeFile(entryFile.filePath, entryFile.contents);

    if (!exists) {
      // Give time for watchman to compute the file...
      // TODO: Virtual modules which can have dependencies.
      await new Promise((res) => setTimeout(res, 1000));
    }

    return generatedEntry;
  }

  return async (req: ServerRequest, res: ServerResponse, next: (err?: Error) => void) => {
    if (!req.url) return next();

    const url = coerceUrl(req.url);

    // Match `/_expo/@dom`.
    // This URL can contain additional paths like `/_expo/@dom/foo.js?file=...` to help the Safari dev tools.
    if (!url.pathname.startsWith('/_expo/@dom')) {
      return next();
    }

    const file = url.searchParams.get('file');

    if (!file || !file.startsWith('file://')) {
      res.statusCode = 400;
      res.statusMessage = 'Invalid file path: ' + file;
      return res.end();
    }

    warnUnstable();

    // Generate a unique entry file for the webview.
    const generatedEntry = await getDomComponentVirtualEntryModuleAsync(file);

    // Create the script URL
    const metroUrl = new URL(
      createBundleUrlPath({
        ...instanceMetroOptions,
        isDOM: true,
        mainModuleName: path.relative(metroRoot, generatedEntry),
        bytecode: false,
        platform: 'web',
        isExporting: false,
        engine: 'hermes',
        // Required for ensuring bundler errors are caught in the root entry / async boundary and can be recovered from automatically.
        lazy: true,
      }),
      // TODO: This doesn't work on all public wifi configurations.
      getDevServerUrl()
    ).toString();

    res.statusCode = 200;
    // Return HTML file
    res.setHeader('Content-Type', 'text/html');

    res.end(
      // Create the entry HTML file.
      getDomComponentHtml(metroUrl, { title: path.basename(file) })
    );
  };
}

function coerceUrl(url: string) {
  try {
    return new URL(url);
  } catch {
    return new URL(url, 'https://localhost:0');
  }
}

export function getDomComponentVirtualProxy(generatedEntry: string, filePath: string) {
  // filePath relative to the generated entry
  let relativeFilePath = path.relative(path.dirname(generatedEntry), filePath);

  if (!relativeFilePath.startsWith('.')) {
    relativeFilePath = './' + relativeFilePath;
  }

  const stringifiedFilePath = JSON.stringify(relativeFilePath);
  // NOTE: This might need to be in the Metro transform cache if we ever change it.
  const contents = `
// Entry file for the web-side of a DOM Component.
import { registerDOMComponent } from 'expo/dom/internal';

registerDOMComponent(() => import(${stringifiedFilePath}), ${stringifiedFilePath});
`;

  return {
    filePath: generatedEntry,
    contents,
  };
}

export function getDomComponentHtml(src?: string, { title }: { title?: string } = {}) {
  // This HTML is not optimized for `react-native-web` since DOM Components are meant for general React DOM web development.
  return `
<!DOCTYPE html>
<html>
    <head>
        <meta charset="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
        ${title ? `<title>${title}</title>` : ''}
        <style id="expo-dom-component-style">
        /* These styles make the body full-height */
        html,
        body {
          -webkit-overflow-scrolling: touch; /* Enables smooth momentum scrolling */
        }
        /* These styles make the root element full-height */
        #root {
          display: flex;
          flex: 1;
        }
        </style>
    </head>
    <body>
    <noscript>DOM Components require <code>javaScriptEnabled</code></noscript>
        <!-- Root element for the DOM component. -->
        <div id="root"></div>
        ${src ? `<script crossorigin src="${src}"></script>` : ''}
    </body>
</html>`;
}
