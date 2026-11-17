// Image files imported from the renderer: Vite turns the import into the file's URL.
declare module "*.png" {
  const url: string;
  export default url;
}
