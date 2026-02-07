// Script to update ProfilePage - adds combined Polar mutation
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../client/src/pages/ProfilePage.tsx');
let content = fs.readFileSync(filePath, 'utf-8');

// 1. Update imports
content = content.replace(
  "import { useState, useEffect, useRef } from 'react';",
  "import { useState, useEffect, useRef } from 'react';\nimport { useLocation } from 'wouter';"
);

content = content.replace(
  "import { User, Trophy, MapPin, Users, Settings, LogOut, Link2, Unlink, Loader2, RefreshCw, Palette, Watch, Camera } from 'lucide-react';",
  "import { User, Trophy, MapPin, Users, Settings, LogOut, Link2, Unlink, Loader2, RefreshCw, Palette, Watch, Camera, Plus } from 'lucide-react';"
);

// 2. Add navigate to component
content = content.replace(
  'export default function ProfilePage() {\n  const [isSettingsOpen, setIsSettingsOpen] = useState(false);',
  'export default function ProfilePage() {\n  const [, navigate] = useLocation();\n  const [isSettingsOpen, setIsSettingsOpen] = useState(false);'
);

// 3. Add combined mutation after processPolarMutation
const mutationIndex = content.indexOf('  // check for OAuth callback');
const insertPoint = content.lastIndexOf('});', mutationIndex - 1);

const newMutation = `

  // Combined: Import + Process + Redirect to map with animation
  const addNewActivityMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('No user logged in');
      
      // 1. Sync activities from Polar
      const syncRes = await apiRequest('POST', \`/api/polar/sync/\${user.id}\`);
      const syncData = await syncRes.json();
      
      if (!syncData.imported || syncData.imported === 0) {
        throw new Error('No se importaron actividades nuevas');
      }

      // 2. Process all pending activities
      const processRes = await apiRequest('POST', \`/api/polar/process/\${user.id}\`);
      const processData = await processRes.json();

      return { syncData, processData };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/territories'] });
      queryClient.invalidateQueries({ queryKey: ['/api/routes', user?.id] });
      queryClient.invalidateQueries({ queryKey: ['/api/user', user?.id] });
      queryClient.invalidateQueries({ queryKey: [polarActivitiesKey] });
      
      toast({
        title: 'Actividad añadida',
        description: 'Redirigiendo al mapa para ver la animación...',
      });
      
      // Redirect to map with animation flag
      navigate('/?animateLatestActivity=true');
    },
    onError: (error: any) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo añadir la actividad',
        variant: 'destructive',
      });
    },
  });`;

content = content.slice(0, insertPoint + 3) + newMutation + content.slice(insertPoint + 3);

fs.writeFileSync(filePath, content);
console.log('ProfilePage updated successfully');
