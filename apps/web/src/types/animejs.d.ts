declare module 'animejs' {
  interface AnimeParams {
    targets?: unknown;
    translateX?: unknown;
    translateY?: unknown;
    scale?: unknown;
    opacity?: unknown;
    duration?: number;
    delay?: number;
    loop?: boolean;
    easing?: string;
  }
  interface AnimeInstance {
    pause(): void;
  }
  interface AnimeStatic {
    (params: AnimeParams): AnimeInstance;
    stagger(value: number): number;
  }
  const anime: AnimeStatic;
  export default anime;
}
