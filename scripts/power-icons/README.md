# Iconos 3D de los poderes

Cada poder es un modelo 3D hecho en código (`models.js`, con las piezas de `lib.js`) y renderizado con three.js
en Chromium headless: materiales físicos, luz de estudio y fondo transparente. El material sigue la rareza,
como los cofres: común cobre, raro acero, épico oro, legendario cristal.

```bash
cd scripts/power-icons
npm install
node render.js            # todos → out/<id>.png (512 px)
node render.js shield     # solo uno
node install.js           # → ios/Kaemedos/Assets.xcassets/power_<id>.imageset (384 px)
```

El botón de Poderes usa el mismo generador: `node render.js powers_icon` (asset `powers_icon`, 256 px).

Para un poder nuevo: añade su modelo en `MODELS` y su rareza en `RARITIES` (`models.js`). En la app, `PowerArt`
usa el asset `power_<id>` y, si no existe, el SF Symbol de `PowerSymbol`.
