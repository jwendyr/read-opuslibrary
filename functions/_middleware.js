import { onRequestGet as getOpdsXml } from './opds.xml.js';
import { onRequestGet as getOpdsJson } from './opds.json.js';

export async function onRequest(context) {
  const { pathname } = new URL(context.request.url);
  if (pathname === '/opds.xml') {
    return getOpdsXml(context);
  }
  if (pathname === '/opds.json') {
    return getOpdsJson(context);
  }
  return context.next();
}
