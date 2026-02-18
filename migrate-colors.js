import { createClient } from '@libsql/client';

/**
 * Migration script: Reassign old user colors to the new accessible palette.
 * 
 * Algorithm:
 * 1. Fetch all users and friendships
 * 2. For each user, find the closest new color to their current color
 * 3. Build friend groups and resolve conflicts (no two friends share a color)
 *    using a greedy graph-coloring approach sorted by #friends descending
 * 4. Update all users in the database
 */

// Old palette (for reference)
const OLD_COLORS = [
  '#10b981', '#3b82f6', '#f43f5e', '#a855f7', '#f97316',
  '#06b6d4', '#ec4899', '#84cc16', '#8b5cf6', '#0ea5e9',
];

// New accessible palette
const NEW_COLORS = [
  '#E41A1C', // Rojo
  '#377EB8', // Azul
  '#4DAF4A', // Verde
  '#984EA3', // Morado
  '#FF7F00', // Naranja
  '#A65628', // Marrón
  '#F781BF', // Rosa
  '#999999', // Gris
  '#66C2A5', // Menta
  '#FC8D62', // Coral
  '#8DA0CB', // Lavanda
  '#E78AC3', // Rosa magenta
];

const NEW_COLOR_NAMES = {
  '#E41A1C': 'Rojo',
  '#377EB8': 'Azul',
  '#4DAF4A': 'Verde',
  '#984EA3': 'Morado',
  '#FF7F00': 'Naranja',
  '#A65628': 'Marrón',
  '#F781BF': 'Rosa',
  '#999999': 'Gris',
  '#66C2A5': 'Menta',
  '#FC8D62': 'Coral',
  '#8DA0CB': 'Lavanda',
  '#E78AC3': 'Rosa magenta',
};

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

function colorDistance(hex1, hex2) {
  const c1 = hexToRgb(hex1);
  const c2 = hexToRgb(hex2);
  // Weighted Euclidean distance (human perception weighting)
  const rMean = (c1.r + c2.r) / 2;
  const dR = c1.r - c2.r;
  const dG = c1.g - c2.g;
  const dB = c1.b - c2.b;
  return Math.sqrt(
    (2 + rMean / 256) * dR * dR +
    4 * dG * dG +
    (2 + (255 - rMean) / 256) * dB * dB
  );
}

function findClosestNewColor(oldColor) {
  let bestDist = Infinity;
  let bestColor = NEW_COLORS[0];
  for (const nc of NEW_COLORS) {
    const d = colorDistance(oldColor.toUpperCase(), nc);
    if (d < bestDist) {
      bestDist = d;
      bestColor = nc;
    }
  }
  return bestColor;
}

// Sort new colors by similarity to the user's old color (preference order)
function sortNewColorsByPreference(oldColor) {
  return [...NEW_COLORS].sort((a, b) => 
    colorDistance(oldColor.toUpperCase(), a) - colorDistance(oldColor.toUpperCase(), b)
  );
}

async function migrateColors() {
  if (!process.env.TURSO_AUTH_TOKEN) {
    console.error('❌ TURSO_AUTH_TOKEN environment variable is required');
    process.exit(1);
  }

  const client = createClient({
    url: process.env.DATABASE_URL || 'libsql://runna-io-jpoves0.aws-eu-west-1.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  console.log('🎨 Starting color migration to accessible palette...\n');

  // 1. Fetch all users
  const usersResult = await client.execute('SELECT id, username, name, color FROM users');
  const users = usersResult.rows;
  console.log(`Found ${users.length} users\n`);

  if (users.length === 0) {
    console.log('No users to migrate.');
    return;
  }

  // 2. Fetch all friendships
  const friendshipsResult = await client.execute('SELECT user_id, friend_id FROM friendships');
  const friendships = friendshipsResult.rows;
  console.log(`Found ${friendships.length} friendship rows\n`);

  // Build adjacency list (friends graph)
  const friendsMap = new Map(); // userId -> Set<friendId>
  for (const u of users) {
    friendsMap.set(u.id, new Set());
  }
  for (const f of friendships) {
    if (friendsMap.has(f.user_id)) friendsMap.get(f.user_id).add(f.friend_id);
    if (friendsMap.has(f.friend_id)) friendsMap.get(f.friend_id).add(f.user_id);
  }

  // 3. Initial mapping: closest new color for each user
  const userColorMap = new Map(); // userId -> newColor
  const userOldColor = new Map(); // userId -> oldColor

  for (const u of users) {
    const oldColor = u.color;
    userOldColor.set(u.id, oldColor);
    
    // Check if user already has a new palette color
    const isAlreadyNew = NEW_COLORS.some(nc => nc.toUpperCase() === oldColor.toUpperCase());
    if (isAlreadyNew) {
      userColorMap.set(u.id, NEW_COLORS.find(nc => nc.toUpperCase() === oldColor.toUpperCase()));
    } else {
      userColorMap.set(u.id, findClosestNewColor(oldColor));
    }
  }

  // 4. Resolve conflicts using greedy graph coloring
  // Process users with the most friends first (they have the most constraints)
  const sortedUsers = [...users].sort((a, b) => {
    const friendsA = friendsMap.get(a.id)?.size || 0;
    const friendsB = friendsMap.get(b.id)?.size || 0;
    return friendsB - friendsA; // Most constrained first
  });

  // Multiple passes to resolve all conflicts
  let conflicts = true;
  let pass = 0;
  while (conflicts && pass < 20) {
    conflicts = false;
    pass++;

    for (const u of sortedUsers) {
      const myColor = userColorMap.get(u.id);
      const myFriends = friendsMap.get(u.id) || new Set();

      // Get colors used by my friends
      const friendColorSet = new Set();
      for (const fId of myFriends) {
        friendColorSet.add(userColorMap.get(fId));
      }

      // If my color conflicts with a friend's, pick the next best available
      if (friendColorSet.has(myColor)) {
        conflicts = true;
        const oldColor = userOldColor.get(u.id);
        const preferred = sortNewColorsByPreference(oldColor);
        
        let assigned = false;
        for (const candidate of preferred) {
          if (!friendColorSet.has(candidate)) {
            userColorMap.set(u.id, candidate);
            assigned = true;
            break;
          }
        }
        
        if (!assigned) {
          // Extremely unlikely with 12 colors, but pick any that works
          console.warn(`⚠️  User ${u.username} has ${myFriends.size} friends - all 12 colors taken! Keeping closest.`);
          userColorMap.set(u.id, preferred[0]);
        }
      }
    }
  }

  if (conflicts) {
    console.warn('⚠️  Could not resolve all conflicts after 20 passes (likely >12 mutual friends somewhere)');
  }

  // 5. Report changes
  console.log('=== Color assignments ===\n');
  let changedCount = 0;
  let unchangedCount = 0;

  for (const u of users) {
    const oldColor = userOldColor.get(u.id);
    const newColor = userColorMap.get(u.id);
    const changed = oldColor.toUpperCase() !== newColor.toUpperCase();
    
    if (changed) {
      changedCount++;
      const newName = NEW_COLOR_NAMES[newColor] || newColor;
      console.log(`  ${u.name} (@${u.username}): ${oldColor} → ${newColor} (${newName})`);
    } else {
      unchangedCount++;
    }
  }

  console.log(`\n📊 Summary: ${changedCount} will change, ${unchangedCount} unchanged\n`);

  // 6. Verify no friend conflicts remain
  let conflictCount = 0;
  for (const u of users) {
    const myColor = userColorMap.get(u.id);
    const myFriends = friendsMap.get(u.id) || new Set();
    for (const fId of myFriends) {
      if (userColorMap.get(fId) === myColor) {
        conflictCount++;
      }
    }
  }
  if (conflictCount > 0) {
    console.warn(`⚠️ ${conflictCount / 2} friend pairs still share a color (user has >12 friends)`);
  } else {
    console.log('✅ No friend color conflicts!\n');
  }

  // 7. Apply updates
  console.log('Applying updates to database...\n');
  let updated = 0;
  for (const u of users) {
    const oldColor = userOldColor.get(u.id);
    const newColor = userColorMap.get(u.id);
    
    if (oldColor.toUpperCase() !== newColor.toUpperCase()) {
      await client.execute({
        sql: 'UPDATE users SET color = ? WHERE id = ?',
        args: [newColor, u.id],
      });
      updated++;
    }
  }

  console.log(`✅ Done! Updated ${updated} users to new accessible palette.`);
}

migrateColors().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
