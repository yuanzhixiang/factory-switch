/** 状态区里的一行 */
export interface LogLine {
  id: number;
  text: string;
  tone: "info" | "success" | "error";
}
