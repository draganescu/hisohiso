declare module 'qrcode-terminal' {
  function generate(text: string, options?: { small?: boolean }, callback?: (code: string) => void): void;
  export default { generate };
}
