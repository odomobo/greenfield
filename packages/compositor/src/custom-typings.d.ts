import { InputOutput } from './InputOutput'

declare module '@gfld/compositor-protocol' {
  export interface ClientUserData {
    readonly inputOutput: InputOutput
  }
}
