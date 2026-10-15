// Old address hoh-epl.rngn.workers.dev: permanent redirect to the site's address epl.rngn.workers.dev (path and query
// kept; the browser keeps the #fragment). Deploy: wrangler deploy --config epl-worker/wrangler.redirect.jsonc
const TARGET = 'https://epl.rngn.workers.dev';

export default {
  fetch(request) {
    const { pathname, search } = new URL(request.url);
    return Response.redirect(`${TARGET}${pathname}${search}`, 301);
  },
};
