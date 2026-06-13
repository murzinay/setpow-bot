/**
 * Иконки мини-аппа Cryox — тонкие line-иконки (stroke=currentColor),
 * наследуют цвет родителя. Размер по умолчанию 20, переопределяется
 * пропом size. Набор покрывает ровно то, что используется в UI.
 */

interface IconProps {
  size?: number;
}

function svg(size: number, children: JSX.Element, fill = false): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const IcKey = ({ size = 22 }: IconProps) =>
  svg(
    size,
    <>
      <circle cx="8.5" cy="8.5" r="4.5" />
      <path d="M11.5 11.5L20 20M16 16l3-1M14 14l2 2" />
    </>,
  );

export const IcSupport = ({ size = 22 }: IconProps) =>
  svg(
    size,
    <path d="M21 11.5a8.38 8.38 0 01-9 8.3 8.5 8.5 0 01-3.8-.9L3 20l1.1-4.2A8.38 8.38 0 0112 3.5a8.5 8.5 0 019 8z" />,
  );

export const IcProfile = ({ size = 22 }: IconProps) =>
  svg(
    size,
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
    </>,
  );

export const IcEye = ({ size = 15 }: IconProps) =>
  svg(
    size,
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>,
  );

export const IcCopy = ({ size = 18 }: IconProps) =>
  svg(
    size,
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15V5a2 2 0 012-2h10" />
    </>,
  );

export const IcRefresh = ({ size = 16 }: IconProps) =>
  svg(size, <path d="M21 12a9 9 0 11-2.6-6.4M21 4v5h-5" />);

export const IcStar = ({ size = 20 }: IconProps) =>
  svg(size, <path d="M12 2l2 6 6 .5-4.5 4 1.5 6-5-3.2L7.5 18.5l1.5-6L4.5 8.5 10.5 8z" />);

export const IcChevron = ({ size = 17 }: IconProps) => svg(size, <path d="M9 6l6 6-6 6" />);

export const IcChevronDown = ({ size = 18 }: IconProps) => svg(size, <path d="M6 9l6 6 6-6" />);

export const IcBack = ({ size = 20 }: IconProps) => svg(size, <path d="M15 6l-6 6 6 6" />);

export const IcGift = ({ size = 20 }: IconProps) =>
  svg(
    size,
    <path d="M20 12v8H4v-8M2 7h20v5H2zM12 22V7M12 7C9 7 7 5 8 3.5 9 2 12 4 12 7zM12 7c3 0 5-2 4-3.5C15 2 12 4 12 7z" />,
  );

export const IcTag = ({ size = 20 }: IconProps) =>
  svg(
    size,
    <path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0l-7-7a2 2 0 01-.6-1.4V5a2 2 0 012-2h6.8a2 2 0 011.4.6l7.4 7.4a2 2 0 010 2.4z" />,
  );

export const IcHelp = ({ size = 20 }: IconProps) =>
  svg(
    size,
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 115 .5c0 1.5-2.5 2-2.5 3.5" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </>,
  );

export const IcTg = ({ size = 19 }: IconProps) =>
  svg(size, <path d="M22 3L2 11l6 2.2L18 6l-7.5 9 .2 5 3-3.5L19 21z" />, true);

export const IcDoc = ({ size = 20 }: IconProps) =>
  svg(size, <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M9 13h6M9 17h6" />);

export const IcSun = ({ size = 20 }: IconProps) =>
  svg(
    size,
    <>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
    </>,
  );

export const IcCheck = ({ size = 17 }: IconProps) => svg(size, <path d="M5 12l5 5 9-11" />);

export const IcShare = ({ size = 18 }: IconProps) =>
  svg(
    size,
    <>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4" />
    </>,
  );
