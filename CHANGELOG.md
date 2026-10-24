# Changelog

## [0.7.0](https://github.com/PhaseN-Digital/phasen-sitebuilder/compare/phasen-sitebuilder-v0.6.0...phasen-sitebuilder-v0.7.0) (2026-10-24)


### Features

* **import:** import any website with an ownership declaration and provenance marker ([#141](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/141)) ([#144](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/144)) ([8222a76](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/8222a76730285a5704341333ff6dd7229fb967d9))
* **publish:** publish to subdomains ([#135](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/135)) ([#140](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/140)) ([823cc2f](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/823cc2ff83c0b432d60e30b91779092ffbcf1bcc))
* **settings:** app-wide Settings page with per-site overrides ([#134](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/134)) ([#142](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/142)) ([a7a7e7c](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/a7a7e7c3777bcc53442b4f4d95e210023a03cc7e))


### Bug Fixes

* **app:** single-instance lock so two copies can't clobber JSON stores ([#149](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/149)) ([#154](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/154)) ([4f2e73f](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/4f2e73f2eeeccf00290161cfef8643fedfdde70e))
* **editor:** flush pending autosave before leaving the editor ([#143](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/143)) ([#151](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/151)) ([6ec2091](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/6ec20914f30e6a469bdf70c7d75cf553f67e359c))
* **import:** gate package export on the ownership declaration, keep app-password verification, mark previewed copies ([#145](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/145)) ([#152](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/152)) ([6b09700](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/6b0970090709858f5c23c5c0dcf359c1fba6f43a))
* **settings:** atomic, queued JSON store with backup recovery ([#148](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/148)) ([6f68a43](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/6f68a439b4634c78842393feb5f9732de7cd7dbc))

## [0.6.0](https://github.com/PhaseN-Digital/phasen-sitebuilder/compare/phasen-sitebuilder-v0.5.0...phasen-sitebuilder-v0.6.0) (2026-10-24)


### Features

* **app:** brand the editor with PhaseN Digital assets ([#59](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/59)) ([#119](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/119)) ([6e68bbd](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/6e68bbde62a56da11de5a0c22b9155dc4571b33f))
* **editor:** fuller rich text editor with Quill 2 ([#120](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/120)) ([#127](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/127)) ([f3b2e21](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/f3b2e219bae3f07060dcad9e185ec2db0f963b44))
* **forms:** keep form messages in a per-site D1 inbox ([#75](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/75)) ([#121](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/121)) ([f156aa6](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/f156aa69afc3d1457569557b8bfe23dc36f39a79))
* **themes:** Theme Builder for local themes ([#130](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/130)) ([#132](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/132)) ([a4b3d2d](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/a4b3d2d71ccd92901771d7af922ea9838f460dec))


### Bug Fixes

* pick black or white text by higher WCAG contrast ([#124](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/124)) ([#125](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/125)) ([ac88646](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/ac88646e7ecc22380d3f4ee76b6ab56434c77a60))

## [0.5.0](https://github.com/PhaseN-Digital/phasen-sitebuilder/compare/phasen-sitebuilder-v0.4.4...phasen-sitebuilder-v0.5.0) (2026-10-24)


### Features

* **copied:** edit link targets of linked images ([#62](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/62)) ([#107](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/107)) ([85e8797](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/85e8797300deb0fda15ba7de415224f4eeedcdb7))
* **publish:** take a site offline, and offer it when deleting ([#71](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/71)) ([#100](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/100)) ([2a68fa5](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/2a68fa504c24ada705621e8cc6543d091bec9835))
* **seo:** page titles, descriptions, share images, canonical, sitemap and robots.txt ([#74](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/74)) ([#114](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/114)) ([9bcf5c4](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/9bcf5c41c5b438d82ecd29087bdff0d45547e6dc))


### Bug Fixes

* **import:** skip WordPress-only shop and account pages ([#116](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/116)) ([fe9664c](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/fe9664c34d68da7eaf1476d39178e4cb913d3173))
* **mirror:** canonical/og tags on the published host, keep original robots.txt/sitemap.xml ([#115](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/115)) ([#117](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/117)) ([1d62615](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/1d62615577ef98ee0b826100266b07eadedb8c9b))

## [0.4.4](https://github.com/PhaseN-Digital/phasen-sitebuilder/compare/phasen-sitebuilder-v0.4.3...phasen-sitebuilder-v0.4.4) (2026-10-24)


### Bug Fixes

* **mirror:** strip copied trackers and self-host Google Fonts ([#105](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/105)) ([c4b34f9](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/c4b34f968ecbc24afb4757f1b950a748aab67613))
* **release:** gate the release PR's head from the branch ref and re-gate stuck PRs ([#112](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/112)) ([54d4b57](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/54d4b57f657f6e6a7a834920e2fa86d2c6ab5960))
* **test:** narrow wordpress built-page check to the fixture's hostile markup ([#110](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/110)) ([e51ebb1](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/e51ebb17b166a08cf45f5b14faa5313cbe515381))
* **themes:** mobile menu toggle for theme headers ([#82](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/82)) ([#104](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/104)) ([c544685](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/c544685d2cc1443a6a5d514989ae2fd8e0baedb7))

## [0.4.3](https://github.com/PhaseN-Digital/phasen-sitebuilder/compare/phasen-sitebuilder-v0.4.2...phasen-sitebuilder-v0.4.3) (2026-10-24)


### Bug Fixes

* **import:** keep WordPress page addresses, 301 the rest ([#72](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/72)) ([#98](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/98)) ([577a7c5](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/577a7c5a1c3c86932cabd555e95d215b2e2dbd25))

## [0.4.2](https://github.com/PhaseN-Digital/phasen-sitebuilder/compare/phasen-sitebuilder-v0.4.1...phasen-sitebuilder-v0.4.2) (2026-10-23)


### Bug Fixes

* **release:** only auto-merge a patch release onto the main it tested ([#101](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/101)) ([032888f](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/032888fda79ad923ac9e172bdadaf665e730ace6))

## [0.4.1](https://github.com/PhaseN-Digital/phasen-sitebuilder/compare/phasen-sitebuilder-v0.4.0...phasen-sitebuilder-v0.4.1) (2026-10-23)


### Bug Fixes

* read copied form questions from nearby text, not raw field names ([#89](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/89)) ([f692a46](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/f692a46651e580d6ffbebc77b75459352903b949))

## [0.4.0](https://github.com/PhaseN-Digital/phasen-sitebuilder/compare/phasen-sitebuilder-v0.3.0...phasen-sitebuilder-v0.4.0) (2026-10-23)


### Features

* **assets:** stop publishing and delete unused uploaded images ([#14](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/14)) ([ee47922](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/ee479223271afadd0a49ce29fd90ccffb9eafa06))
* **assets:** stop publishing and delete unused uploaded images ([#14](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/14)) ([9d2016a](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/9d2016a45c52beee42175b4daa8fad47bfbb98c2))
* **build:** build Intel macOS installer ([#16](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/16)) ([4ec1db8](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/4ec1db8ada898adb18d0b2b94cfa7a3406f38fda))
* **build:** build Intel macOS installer on macos-15-intel ([#16](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/16)) ([ef65b83](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/ef65b83a1edb2eef1a11f71fd2574df6ed24f27e))
* **build:** generate a privacy page for sites with forms ([#8](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/8)) ([bbecf5f](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/bbecf5fd5819b4a3f05d6b3f60637ba0830958e8))
* **build:** stub workerd binary in packaged app ([#15](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/15)) ([a2d85a5](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/a2d85a527e2390342f4977048aa81f8d56e5b7ef))
* **build:** stub workerd binary in packaged app ([#15](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/15)) ([5d4f36c](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/5d4f36ce6a56dafc18004d7f481af183bee55416))
* **copy:** edit link targets on copied pages ([#10](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/10)) ([#63](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/63)) ([42a61c7](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/42a61c70509c75ad2e21f1ca1a6528014b85aba0))
* Elementor kit colours, font and logo in editable import ([#67](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/67)) ([50ce6e4](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/50ce6e42d60e2cd20ae11ba5ece436798f62979d))
* load bundled themes as theme packages ([#57](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/57)) ([#64](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/64)) ([7a16634](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/7a16634c2057fc040cb8cfef8f6d21a738316797))
* optional Google Analytics with cookie consent ([539d04c](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/539d04cef1ea99d8c19121b0830b9cc544a8ddef))
* optional Google Analytics with cookie consent ([#13](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/13)) ([ef54291](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/ef5429197d88b0df80768620ac9476b501bb7672))
* **publish:** redirect www to the apex on custom domains ([#12](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/12)) ([4ea165e](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/4ea165e1f11321a5e90c376ca04c2b7ad2504f36))
* **publish:** redirect www to the apex on custom domains ([#12](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/12)) ([47292da](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/47292da7aa11e3c7d52e2a7c178b9ac663c7e393))
* **release:** sign and notarise installers when signing secrets exist ([#6](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/6)) ([d09f85d](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/d09f85d7e06991fcd81f0e69abb1bcc00a6aab88))
* **release:** sign and notarise installers when signing secrets exist ([#6](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/6)) ([1112da1](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/1112da1c8df65d642895f40d5719d4a6f7a1cbf6))
* **update:** notify when a newer version is available ([#37](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/37)) ([#68](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/68)) ([07c0315](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/07c0315497ed332b5d5bd2cc6ba6817f60364ed3))


### Bug Fixes

* **mirror:** copy Elementor's runtime-loaded scripts and drop WordPress API links ([#3](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/3)) ([d1d4686](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/d1d468610e2212a368d147b6690df5b6618d829e))
* **mirror:** copy WordPress installed in a subfolder ([3c40e8c](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/3c40e8c838a20f1c4ec3afa44d16ca68ee312a61))
* **mirror:** copy WordPress installed in a subfolder ([#23](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/23)) ([f953299](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/f953299621597f34e8f3e6d5b7a00383dfc3eeea))
* **mirror:** re-wire only enquiry forms, handle conditional and checkbox fields ([#22](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/22)) ([#69](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/69)) ([e56ba3a](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/e56ba3a9746f3affcf8d2c3e3af543980405af84))
* stop tracking a node_modules symlink ([aca46cc](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/aca46cc86f2d28dfe081a28ae9094e4b4a16a775))
* stop tracking a node_modules symlink and ignore it in any form ([#44](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/44)) ([334478c](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/334478cafaa7b683ea0839f778f646421595e76b))
* **test:** never let a failed screenshot fail a regression check ([#87](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/87)) ([#88](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/88)) ([cb8f2a9](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/cb8f2a9433bc5e4e0389613f8e622f1db91b2cb5))
* WordPress import fixes from testing against real sites ([0faedeb](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/0faedeb8ed3856d52f0145d32a2465d59573f0c1))
* **wordpress:** fetch pages anonymously unless the site refuses ([#53](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/53)) ([d7a908d](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/d7a908df211c2981dbe269eb72f4aba70dedf000))

## [0.3.0](https://github.com/PhaseN-Digital/phasen-sitebuilder/compare/phasen-sitebuilder-v0.2.0...phasen-sitebuilder-v0.3.0) (2026-10-23)


### Features

* **copied:** undo and revert-to-original for copied pages ([#7](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/7)) ([6c526be](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/6c526bee405e2045491d64710af538be8864a81c))
* **copied:** undo and revert-to-original for copied pages ([#7](https://github.com/PhaseN-Digital/phasen-sitebuilder/issues/7)) ([652d8d6](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/652d8d6ee6f9c5986af3d53a3aa04beeb723b002))

## [0.2.0](https://github.com/PhaseN-Digital/phasen-sitebuilder/compare/phasen-sitebuilder-v0.1.0...phasen-sitebuilder-v0.2.0) (2026-10-23)


### Features

* desktop site builder that publishes to Cloudflare Workers ([f4dcbae](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/f4dcbaed979404b3eb109300ae22c62522f2515e))
* import WordPress sites, with editable exact copies for page builders ([e58cf73](https://github.com/PhaseN-Digital/phasen-sitebuilder/commit/e58cf73e12c0ace2a901351164ec9ecec15bdca7))
