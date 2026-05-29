import { Html, Head, Main, NextScript } from 'next/document'

export default function Document() {
  return (
    <Html lang="pt-BR">
      <Head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <meta name="theme-color" content="#080E1D" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
