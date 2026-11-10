import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Skeleton } from "../ui/Skeleton";
import "./deviceShell.css";

/** Header placeholder while the device list is still loading. */
export function DeviceHeaderSkeleton() {
  return (
    <div className="device-head-box" aria-busy="true" aria-label="Loading device">
      <header className="device-head">
        <Link className="back" to="/">
          <ArrowLeft className="i sm" aria-hidden="true" /> Fleet
        </Link>
        <div className="dh-id dh-skel">
          <Skeleton variant="title" width="40%" />
          <Skeleton variant="line" width="55%" />
          <div className="chips">
            <Skeleton variant="line" width={72} height={24} />
            <Skeleton variant="line" width={96} height={24} />
            <Skeleton variant="line" width={64} height={24} />
          </div>
        </div>
      </header>
    </div>
  );
}
