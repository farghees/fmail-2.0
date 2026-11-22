# Setup tutorial

Standalone React/Three.js setup guide, separate from the Fmail app. The guide defaults to Malay and includes English, copyable prompts, reduced-motion support and a static fallback when WebGL is unavailable.

## Build

Run `npm ci` then `npm run build` from this directory. Vite outputs `dist/` for serving below `/setup/`.

## Optional Worker

`worker.js` expects an `ASSETS` binding serving the build. `/setup` redirects to `/setup/`. Other paths return 404 unless the operator sets `MAIL_APP_ORIGIN` to the HTTPS webmail origin. That setting enables redirects preserving path and query, and must use a different origin to avoid a redirect loop. Deployment/account configuration and credentials are intentionally not included.

Review links, domains, provider instructions, costs and permission needs for your installation before publishing. The tutorial never collects API keys. App signup and forwarding still need operator configuration and live tests.

## License

This project is distributed with the repository's AGPL-3.0 license. React, Three.js and build dependencies retain their own licenses.

The source links in the tutorial assume the app serves its generated archive at `/source.tar.gz` on the same host and the operator publishes the tutorial archive at `/setup/tutorial-source.tar.gz`. Publishing this repository alone does not create those live endpoints or update the existing tutorial website.
