"""The host's own address on the reader's tailnet, for a charm with no phone in the room.

The app asks ``GET talk`` where the charm calls. The address the app dialled is the app's own:
public, https, and usually the one a proxy fronts. The charm reaches the host over the tailnet in
plain http instead, and only the host can say that address, so this module finds it: the
100.64.0.0/10 address Tailscale gives the machine, and the port this API server is listening on.

Two ways, in order, because a host can be on a tailnet without an interface: ``tailscale ip -4``
knows a userspace-networking node's address, and an interface scan finds the kernel's. Neither
answer is guessed — a host that cannot say its address answers nothing, and the app tells the reader
what the switch's other position needs.
"""

from __future__ import annotations

import ipaddress
import socket
import subprocess
from typing import Any, Optional

# What Tailscale hands out: the CGNAT range, which nothing else on a host is in.
TAILNET = ipaddress.ip_network("100.64.0.0/10")

# The route this module's answer rides on: the charm's address is the prefix it answers at, which is
# the request's own path with this cut off.
TAIL = "/talk"


def _on_tailnet(address: Any) -> bool:
    """Whether ``address`` is one the tailnet handed out. Anything unparsable is not."""
    try:
        return ipaddress.ip_address(str(address).strip()) in TAILNET
    except ValueError:
        return False


def _from_cli() -> Optional[str]:
    """The address `tailscale ip -4` names, or nothing when the CLI is not there to ask."""
    try:
        done = subprocess.run(
            ["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=2, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    for line in (done.stdout or "").splitlines():
        if _on_tailnet(line):
            return line.strip()
    return None


def _from_interfaces() -> Optional[str]:
    """The first 100.64/10 address on a network interface, on a host whose kernel has one."""
    try:
        import fcntl
        import struct
    except ImportError:  # not a Unix kernel: the CLI is the only way to know
        return None
    try:
        names = socket.if_nameindex()
    except OSError:
        return None
    for _, name in names:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            # SIOCGIFADDR's own number, so this needs no module a wheel would have to ship.
            packed = fcntl.ioctl(sock.fileno(), 0x8915, struct.pack("256s", name[:15].encode()))
            address = socket.inet_ntoa(packed[20:24])
        except OSError:
            continue
        finally:
            sock.close()
        if _on_tailnet(address):
            return address
    return None


def tailnet_ip() -> Optional[str]:
    """This host's address on the reader's tailnet, or None when it has none it can name."""
    return _from_cli() or _from_interfaces()


def local_port(request: Any) -> Optional[int]:
    """The port this API server is listening on, read off the request's own socket.

    Not the ``Host`` header's: behind a proxy that is the proxy's, and a tailnet caller can reach the
    port the server holds and no other. A request this host cannot answer that for names no address.
    """
    transport = getattr(request, "transport", None)
    extra = getattr(transport, "get_extra_info", None)
    if extra is None:
        return None
    try:
        sockname = extra("sockname")
    except Exception:  # a transport that refuses the question is one with no answer
        return None
    if not sockname or not isinstance(sockname, (tuple, list)) or len(sockname) < 2:
        return None
    port = sockname[1]
    return port if isinstance(port, int) and 0 < port < 65536 else None


def charm_address(request: Any) -> Optional[str]:
    """``http://<tailnet ip>:<port><prefix>`` — where a charm on the tailnet calls — or None.

    None is the answer whenever this host cannot say one of the two parts, and the caller omits the
    key rather than answering an address the charm would dial and fail on.
    """
    path = getattr(request, "path", "") or ""
    if not isinstance(path, str) or not path.endswith(TAIL):
        return None
    port = local_port(request)
    ip = tailnet_ip()
    if not port or not ip:
        return None
    return f"http://{ip}:{port}{path[: -len(TAIL)]}"
