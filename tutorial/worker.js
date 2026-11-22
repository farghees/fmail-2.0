export default {
 async fetch(request,env) {
  const url=new URL(request.url);
  if(url.pathname==='/setup'){url.pathname='/setup/';return Response.redirect(url.toString(),301);}
  if(!url.pathname.startsWith('/setup/')) {
   if (!env.MAIL_APP_ORIGIN) return new Response('Not found', {status:404});
   const destination = new URL(env.MAIL_APP_ORIGIN);
   if (destination.protocol !== 'https:' || destination.origin === url.origin) return new Response('Invalid redirect configuration', {status:500});
   destination.pathname=url.pathname; destination.search=url.search;
   return Response.redirect(destination.toString(),301);
  }
  const response=await env.ASSETS.fetch(request);
  const headers=new Headers(response.headers);
  headers.set('X-Content-Type-Options','nosniff');
  headers.set('Referrer-Policy','strict-origin-when-cross-origin');
  headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  return new Response(response.body,{status:response.status,headers});
 }
};
