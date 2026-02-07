#!/usr/bin/env python3
import re

# Read the file
with open(r'c:\Users\jpove\Downloads\runna-io (24)\runna-io\client\src\pages\ProfilePage.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add useLocation import after first line
content = content.replace(
    "import { useState, useEffect, useRef } from 'react';",
    "import { useState, useEffect, useRef } from 'react';\nimport { useLocation } from 'wouter';"
)

# 2. Add Plus to lucide icons
content = content.replace(
    "import { User, Trophy, MapPin, Users, Settings, LogOut, Link2, Unlink, Loader2, RefreshCw, Palette, Watch, Camera } from 'lucide-react';",
    "import { User, Trophy, MapPin, Users, Settings, LogOut, Link2, Unlink, Loader2, RefreshCw, Palette, Watch, Camera, Plus } from 'lucide-react';"
)

# 3. Add navigate hook to component
content = content.replace(
    "export default function ProfilePage() {\n  const [isSettingsOpen, setIsSettingsOpen] = useState(false);",
    "export default function ProfilePage() {\n  const [, navigate] = useLocation();\n  const [isSettingsOpen, setIsSettingsOpen] = useState(false);"
)

# 4. Add combined mutation after processPolarMutation
mutation_code = '''
  // Combined: Import + Process + Redirect to map with animation
  const addNewActivityMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('No user logged in');
      
      // 1. Sync activities from Polar
      const syncRes = await apiRequest('POST', `/api/polar/sync/${user.id}`);
      const syncData = await syncRes.json();
      
      if (!syncData.imported || syncData.imported === 0) {
        throw new Error('No se importaron actividades nuevas');
      }

      // 2. Process all pending activities
      const processRes = await apiRequest('POST', `/api/polar/process/${user.id}`);
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
        description: 'Redirigiendo al mapa para verla importada...',
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
  });'''

# Find where to insert the mutation (right after processPolarMutation)
insert_pos = content.find('  // Check for OAuth callback results')
if insert_pos > 0:
    content = content[:insert_pos] + mutation_code + '\n\n' + content[insert_pos:]

# 5. Replace Polar button section - OLD buttons with NEW button
old_buttons = '''                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => syncPolarMutation.mutate()}
                    disabled={syncPolarMutation.isPending}
                    data-testid="button-sync-polar"
                  >
                    {syncPolarMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    Importar nuevas
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => processPolarMutation.mutate()}
                    disabled={processPolarMutation.isPending}
                    data-testid="button-process-polar"
                  >
                    {processPolarMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <MapPin className="h-4 w-4 mr-2" />
                    )}
                    Procesar territorios
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsPolarDisconnectOpen(true)}
                    className="text-destructive"
                    data-testid="button-disconnect-polar"
                  >
                    <Unlink className="h-4 w-4 mr-2" />
                    Desconectar
                  </Button>
                </div>'''

new_buttons = '''                <div className="flex flex-wrap gap-2">
                  <Button
                    className="flex-1"
                    onClick={() => addNewActivityMutation.mutate()}
                    disabled={addNewActivityMutation.isPending}
                    data-testid="button-add-new-activity"
                  >
                    {addNewActivityMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4 mr-2" />
                    )}
                    Añadir Nueva Actividad
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsPolarDisconnectOpen(true)}
                    className="text-destructive"
                    data-testid="button-disconnect-polar"
                  >
                    <Unlink className="h-4 w-4 mr-2" />
                    Desconectar
                  </Button>
                </div>'''

content = content.replace(old_buttons, new_buttons)

# Write back
with open(r'c:\Users\jpove\Downloads\runna-io (24)\runna-io\client\src\pages\ProfilePage.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("ProfilePage updated successfully!")
