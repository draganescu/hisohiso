import { useEffect, useState } from 'react';

export const useKeyboardViewport = (enabled: boolean): boolean => {
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setKeyboardVisible(false);
      return;
    }

    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (!isTouch || !window.visualViewport) {
      return;
    }

    const baseHeight = window.innerHeight;
    const checkKeyboard = () => {
      const visible = window.visualViewport!.height < baseHeight * 0.75;
      setKeyboardVisible(visible);
    };

    checkKeyboard();
    window.visualViewport.addEventListener('resize', checkKeyboard);
    return () => {
      window.visualViewport?.removeEventListener('resize', checkKeyboard);
    };
  }, [enabled]);

  return keyboardVisible;
};
