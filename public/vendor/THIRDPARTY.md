# Third-party assets shipped with LinkWave

The player loads these assets from the local LinkWave host. No external service is contacted during playback. Files are copied without modification.

| Component | Version / source | License and notices | Purpose |
| --- | --- | --- | --- |
| JavascriptSubtitlesOctopus (`libass-wasm`) | 4.1.0, [upstream repository and build sources](https://github.com/libass/JavascriptSubtitlesOctopus/tree/4.1.0), [npm release](https://www.npmjs.com/package/libass-wasm/v/4.1.0) | [MIT license](libass/LICENSE); [complete bundled component notices](libass/COPYRIGHT), including FreeType FTL, libass ISC, and FriBidi LGPL 2.1 or later | ASS/SSA positioning, styles, shaping and animation in a canvas; WebAssembly worker and legacy asm.js worker |
| Noto Sans CJK SC Regular | [Official Noto CJK source](https://github.com/notofonts/noto-cjk/blob/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf), retrieved 2026-11-19 | [SIL Open Font License 1.1](fonts/OFL.txt), Copyright © 2014–2021 Adobe | Chinese, Japanese, Korean and Latin fallback glyphs when a subtitle font is unavailable |

The SubtitlesOctopus distribution contains open-source libraries governed by the licenses in `libass/COPYRIGHT`, including the GNU Lesser General Public License. The JavascriptSubtitlesOctopus source link above supplies the matching release's build files and pinned dependency references; [FriBidi source](https://github.com/fribidi/fribidi) is also available upstream. The host application uses the standalone, replaceable worker assets in `libass/`; recipients may replace or rebuild those library files. Nothing in LinkWave's terms restricts modification or reverse engineering of these third-party libraries for debugging such modifications. Preserve their license notices when redistributing.

Noto font SHA-256: `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`.

The fallback font is unmodified. Subtitle-specific fonts discovered in a user's shared folder are streamed from that folder and are not bundled with LinkWave.
