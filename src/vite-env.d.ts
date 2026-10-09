/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Game server baked into the static (GitHub Pages) build, e.g. https://play.example.com */
  readonly VITE_SERVER_URL?: string;
}
