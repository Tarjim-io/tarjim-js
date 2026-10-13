# React example

A small Vite + React app on `@tarjim/react`: the provider, a language switcher, a plural, and an
`entry()` image with its `alt`.

## Run it

1. `pnpm install` at the repository root.
2. Copy `.env.example` to `.env.local` and fill it in from the console. `.env.local` is ignored by
   git: never commit it, and never put a real key in any other file.
   - `VITE_TARJIM_DELIVERY_URL`: the delivery URL.
   - `VITE_TARJIM_APIKEY`: a delivery key bound to a track and a stage. It ends up in the page.
   - `VITE_APP_VERSION`: your app's `MAJOR.MINOR.PATCH`.
3. `pnpm --dir examples/react dev`

The app expects the keys `app.title`, `cart.items` (a plural) and `hero.image` (an image) in the
`default` bundle, with the languages `en` and `ar`. Without a `.env.local` it still builds and runs,
showing the key names.

`pnpm --dir examples/react build` makes a production build. It needs no network and no built package:
the Vite config reads the packages' sources.
