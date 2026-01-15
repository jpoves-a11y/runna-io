from PIL import Image, ImageDraw, ImageFilter
import os

# Crear imagen Runna.io con mejor calidad
def create_runna_logo():
    size = 512
    # Fondo gradiente (simulado con colores planos en áreas)
    img = Image.new('RGB', (size, size), (230, 230, 235))
    draw = ImageDraw.Draw(img, 'RGBA')
    
    # Crear gradiente de fondo vertical
    for y in range(size):
        ratio = y / size
        r = int(240 - ratio * 10)
        g = int(240 - ratio * 10)
        b = int(245 - ratio * 5)
        draw.line([(0, y), (size, y)], fill=(r, g, b, 255))
    
    # Definir colores del corredor (gradiente)
    colors = {
        'head': (138, 43, 226),      # Púrpura
        'neck': (219, 39, 119),      # Magenta
        'chest': (219, 39, 119),     # Magenta
        'left_arm': (0, 200, 200),   # Cyan
        'right_arm': (0, 200, 200),  # Cyan
        'left_leg': (34, 197, 94),   # Verde
        'right_leg': (255, 127, 39), # Naranja
        'shoes': (100, 100, 100),    # Gris
    }
    
    # Escalas para el corredor
    scale = size / 512
    
    # Cabeza
    head_bbox = [int(200*scale), int(80*scale), int(290*scale), int(170*scale)]
    draw.ellipse(head_bbox, fill=(*colors['head'], 200))
    
    # Ojos
    draw.ellipse([int(220*scale), int(110*scale), int(235*scale), int(125*scale)], fill=(255, 255, 255, 200))
    draw.ellipse([int(270*scale), int(110*scale), int(285*scale), int(125*scale)], fill=(255, 255, 255, 200))
    
    # Cuerpo (torso) - polígono
    torso = [
        (int(225*scale), int(175*scale)),
        (int(275*scale), int(175*scale)),
        (int(285*scale), int(290*scale)),
        (int(215*scale), int(290*scale))
    ]
    draw.polygon(torso, fill=(*colors['chest'], 220))
    
    # Cuello
    draw.rectangle(
        [int(235*scale), int(165*scale), int(265*scale), int(180*scale)],
        fill=(*colors['neck'], 180)
    )
    
    # Brazo izquierdo
    left_arm = [
        (int(215*scale), int(195*scale)),
        (int(140*scale), int(210*scale)),
        (int(130*scale), int(235*scale)),
        (int(210*scale), int(220*scale))
    ]
    draw.polygon(left_arm, fill=(*colors['left_arm'], 200))
    
    # Brazo derecho
    right_arm = [
        (int(285*scale), int(195*scale)),
        (int(360*scale), int(210*scale)),
        (int(370*scale), int(235*scale)),
        (int(290*scale), int(220*scale))
    ]
    draw.polygon(right_arm, fill=(*colors['right_arm'], 200))
    
    # Cinturón/banda
    draw.rectangle(
        [int(215*scale), int(280*scale), int(285*scale), int(300*scale)],
        fill=(200, 100, 150, 200)
    )
    
    # Pierna izquierda
    left_leg = [
        (int(220*scale), int(305*scale)),
        (int(250*scale), int(305*scale)),
        (int(240*scale), int(420*scale)),
        (int(200*scale), int(420*scale))
    ]
    draw.polygon(left_leg, fill=(*colors['left_leg'], 220))
    
    # Pierna derecha
    right_leg = [
        (int(260*scale), int(305*scale)),
        (int(290*scale), int(305*scale)),
        (int(310*scale), int(420*scale)),
        (int(270*scale), int(420*scale))
    ]
    draw.polygon(right_leg, fill=(*colors['right_leg'], 220))
    
    # Zapatilla izquierda
    draw.ellipse(
        [int(190*scale), int(415*scale), int(250*scale), int(450*scale)],
        fill=(*colors['shoes'], 220)
    )
    
    # Zapatilla derecha
    draw.ellipse(
        [int(270*scale), int(415*scale), int(330*scale), int(450*scale)],
        fill=(*colors['shoes'], 220)
    )
    
    # Suavizar un poco
    img = img.filter(ImageFilter.GaussianBlur(radius=0.5))
    
    return img

# Generar y guardar
logo = create_runna_logo()
base_path = r'c:\Users\jpove\Downloads\runna-io (24)\runna-io\client\public'

# Favicon
favicon = logo.resize((64, 64), Image.Resampling.LANCZOS)
favicon.save(os.path.join(base_path, 'favicon.png'))
print('✅ favicon.png')

# Icons
icon_192 = logo.resize((192, 192), Image.Resampling.LANCZOS)
icon_192.save(os.path.join(base_path, 'icon-192.png'))
print('✅ icon-192.png')

icon_512 = logo.resize((512, 512), Image.Resampling.LANCZOS)
icon_512.save(os.path.join(base_path, 'icon-512.png'))
print('✅ icon-512.png')

# Logo
logo_256 = logo.resize((256, 256), Image.Resampling.LANCZOS)
logo_256.save(os.path.join(base_path, 'logo.png'))
print('✅ logo.png')

print('\n✨ Logos de Runna.io actualizados')
