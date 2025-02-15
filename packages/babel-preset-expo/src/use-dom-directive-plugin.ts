/**
 * Copyright © 2024 650 Industries.
 */
import { ConfigAPI, template } from '@babel/core';
import crypto from 'crypto';
import { basename } from 'path';
import url from 'url';

import { getIsProd } from './common';

export function expoUseDomDirectivePlugin(api: ConfigAPI): babel.PluginObj {
  // TODO: Is exporting
  const isProduction = api.caller(getIsProd);
  const platform = api.caller((caller) => (caller as any)?.platform);

  return {
    name: 'expo-use-dom-directive',
    visitor: {
      Program(path, state) {
        // Native only feature.
        if (platform === 'web') {
          return;
        }

        const hasUseDomDirective = path.node.directives.some(
          (directive) => directive.value.value === 'use dom'
        );

        const filePath = state.file.opts.filename;

        if (!filePath) {
          // This can happen in tests or systems that use Babel standalone.
          throw new Error('[Babel] Expected a filename to be set in the state');
        }

        // File starts with "use dom" directive.
        if (!hasUseDomDirective) {
          // Do nothing for code that isn't marked as a dom component.
          return;
        }

        // Assert that a default export must exist and that no other exports should be present.
        // NOTE: In the future we could support other exports with extraction.

        let hasDefaultExport = false;
        // Collect all of the exports
        path.traverse({
          ExportNamedDeclaration(path) {
            throw path.buildCodeFrameError(
              'Modules with the "use dom" directive only support a single default export.'
            );
          },
          ExportDefaultDeclaration() {
            hasDefaultExport = true;
          },
        });

        if (!hasDefaultExport) {
          throw path.buildCodeFrameError(
            'The "use dom" directive requires a default export to be present in the file.'
          );
        }

        const outputKey = url.pathToFileURL(filePath).href;

        const proxyModule: string[] = [
          `import React from 'react';
import { WebView } from 'expo/dom/internal';`,
        ];
        if (isProduction) {
          // MUST MATCH THE EXPORT COMMAND!
          const hash = crypto.createHash('sha1').update(outputKey).digest('hex');

          if (platform === 'ios') {
            const outputName = `www.bundle/${hash}.html`;
            proxyModule.push(`const source = { uri: ${JSON.stringify(outputName)} };`);
          } else if (platform === 'android') {
            // TODO: This is a guess.
            const outputName = `www/${hash}.html`;
            proxyModule.push(
              `const source = { uri: "file:///android_asset" + ${JSON.stringify(outputName)} };`
            );
          } else {
            throw new Error(
              'production "use dom" directive is not supported yet for platform: ' + platform
            );
          }
        } else {
          proxyModule.push(
            // Add the basename to improve the Safari debug preview option.
            `const source = { uri: new URL("/_expo/@dom/${basename(filePath)}?file=" + ${JSON.stringify(outputKey)}, require("react-native/Libraries/Core/Devtools/getDevServer")().url).toString() };`
          );
        }

        proxyModule.push(
          `
export default React.forwardRef((props, ref) => {
  return React.createElement(WebView, { ref, ...props, source });
});`
        );

        // Clear the body
        path.node.body = [];
        path.node.directives = [];

        path.pushContainer('body', template.ast(proxyModule.join('\n')));

        assertExpoMetadata(state.file.metadata);

        // Save the client reference in the metadata.
        state.file.metadata.expoDomComponentReference = outputKey;
      },
    },
  };
}

function assertExpoMetadata(
  metadata: any
): asserts metadata is { expoDomComponentReference?: string } {
  if (metadata && typeof metadata === 'object') {
    return;
  }
  throw new Error('Expected Babel state.file.metadata to be an object');
}
