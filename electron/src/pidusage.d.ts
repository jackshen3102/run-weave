declare module "pidusage" {
  interface Status {
    cpu: number;
    memory: number;
  }

  export default function pidusage(pid: number): Promise<Status>;
}
