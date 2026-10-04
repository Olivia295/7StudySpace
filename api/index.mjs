import { createCloudApp } from '../server/cloud-app.mjs';
import { createCloudStore } from '../server/cloud-store.mjs';
import * as blob from '@vercel/blob';

const app = createCloudApp({ store: createCloudStore({ blob }) });
export default function handler(req, res) {
  const url = new URL(req.url, 'https://study77.invalid');
  const route = url.searchParams.get('route');
  if (route !== null) {
    url.searchParams.delete('route');
    req.url = `/api/${route}${url.searchParams.size ? `?${url.searchParams}` : ''}`;
  }
  return app(req, res);
}
