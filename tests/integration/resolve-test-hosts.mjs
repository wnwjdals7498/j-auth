// Preload only in the isolated integration subprocess. No OS hosts/CA changes.
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns';
import { Agent, setGlobalDispatcher } from 'undici';

if (process.env.JAUTH_TEST_RUNTIME !== 'isolated-cloud')
  throw new Error('Test resolver requires the isolated runtime.');
setGlobalDispatcher(
  new Agent({
    connect: {
      ca: readFileSync(process.env.JAUTH_TLS_CERTIFICATE, 'utf8'),
      lookup: (hostname, options, callback) => {
        if (hostname === 'auth.jgw.test' || hostname === 'jauth.jgw.test') {
          if (options.all)
            callback(null, [{ address: '127.0.0.1', family: 4 }]);
          else callback(null, '127.0.0.1', 4);
        } else lookup(hostname, options, callback);
      },
    },
  }),
);
