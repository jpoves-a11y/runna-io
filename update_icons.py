from PIL import Image
import os

source = r'c:\Users\jpove\Downloads\runna-io (24)\runna-io\client\public\new_favicon.png'
base_path = r'c:\Users\jpove\Downloads\runna-io (24)\runna-io\client\public'

# Cargar imagen original
img = Image.open(source)
print(f'Imagen original: {img.size}')

# Crear versiones en diferentes tamaños
sizes = [
    ('favicon.png', 64),
    ('icon-192.png', 192),
    ('icon-512.png', 512),
    ('logo.png', 256),
]

for filename, size in sizes:
    resized = img.resize((size, size), Image.Resampling.LANCZOS)
    output_path = os.path.join(base_path, filename)
    resized.save(output_path)
    print(f'✅ {filename} ({size}x{size})')

print('\n✨ Todos los iconos actualizados')
