"""
COROS Logo Generator
Generates PNG logos in the required sizes for COROS API application:
- 144x144 (required for app logo)
- 102x102 (required for reduced logo)
- 120x120 (optional - for structured workouts)
- 300x300 (optional - for training plans)

Usage:
    python generate_coros_logos.py

Output:
    ./coros_logos/runna_logo_144x144.png
    ./coros_logos/runna_logo_102x102.png
    ./coros_logos/runna_logo_120x120.png
    ./coros_logos/runna_logo_300x300.png

After generation, email these files to: api@coros.com
Subject: Runna.io - API Images
"""

from PIL import Image
import os

def generate_coros_logos():
    # Source logo (512x512)
    source_path = "client/public/icon-512.png"
    
    if not os.path.exists(source_path):
        print(f"❌ Error: Source logo not found at {source_path}")
        return
    
    # Create output directory
    output_dir = "coros_logos"
    os.makedirs(output_dir, exist_ok=True)
    
    # Load source image
    print(f"📂 Loading source logo from {source_path}...")
    img = Image.open(source_path)
    
    # Required sizes for COROS API
    required_sizes = [144, 102]  # Mandatory
    optional_sizes = [120, 300]  # For structured workouts/training plans
    
    all_sizes = required_sizes + optional_sizes
    
    print("\n🖼️  Generating COROS logo variants...")
    print("=" * 50)
    
    for size in all_sizes:
        # Resize with high-quality LANCZOS filter
        resized = img.resize((size, size), Image.Resampling.LANCZOS)
        
        # Save with optimization
        output_path = os.path.join(output_dir, f"runna_logo_{size}x{size}.png")
        resized.save(output_path, optimize=True)
        
        file_size_kb = os.path.getsize(output_path) / 1024
        status = "✅ REQUIRED" if size in required_sizes else "📦 OPTIONAL"
        print(f"{status} | {size}x{size} → {output_path} ({file_size_kb:.1f} KB)")
    
    print("=" * 50)
    print("\n✨ Logo generation complete!")
    print(f"\n📁 All logos saved to: {os.path.abspath(output_dir)}/")
    print("\n📧 Next steps:")
    print("   1. Review the generated logos")
    print("   2. Email ALL 4 files (or just the 2 required ones) to: api@coros.com")
    print("   3. Subject line: Runna.io - API Images")
    print("\n💡 Note:")
    print("   - 144x144 and 102x102 are REQUIRED")
    print("   - 120x120 and 300x300 are only needed if syncing structured workouts/plans")

if __name__ == "__main__":
    generate_coros_logos()
