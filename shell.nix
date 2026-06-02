{ pkgs ? import (builtins.fetchTarball {
    # Pinned nixpkgs revision — bump with `nix flake update` or manually.
    # To update: replace the URL with a newer nixos-unstable archive,
    # then run nix-shell; Nix will print the new sha256 to paste here.
    url = "https://github.com/NixOS/nixpkgs/archive/nixos-unstable.tar.gz";
    sha256 = "sha256:1p54fm6dkbq62kpi55cr4wyx7b1nsajpsnjgs64cmp073fwi15f7";
  }) {}
}:

pkgs.mkShell {
  packages = [
    pkgs.nodejs_22
  ];
}
