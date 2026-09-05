/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Set by middleware for every authenticated route. */
    user?: import('./lib/auth').Session;
  }
}
