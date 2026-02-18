// Predefined user colors for territory visualization - Accessible palette (colorblind-safe)
export const USER_COLORS = [
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

// Human-readable Spanish color names for each color
export const USER_COLOR_NAMES: Record<string, string> = {
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

export function getRandomUserColor(): string {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
}

export function getUserColorByIndex(index: number): string {
  return USER_COLORS[index % USER_COLORS.length];
}
